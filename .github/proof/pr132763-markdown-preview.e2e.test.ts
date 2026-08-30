import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  controlUiE2eWaitTimeoutMs,
  defaultControlUiFeatureMethods,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/pr132763-markdown-preview",
);
const productHead = process.env.CANDIDATE_SHA ?? "unknown";

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("PR 132763 exact-head Markdown preview proof", () => {
  beforeAll(async () => {
    fs.mkdirSync(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("proves the running Control UI Markdown Review path", async () => {
    const context = await browser.newContext({
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    const remoteImageRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("proof.invalid")) {
        remoteImageRequests.push(request.url());
      }
    });

    const storedMarkdown = [
      "# Stored operator draft",
      "",
      "## Guide",
      "",
      "![Private diagram](https://proof.invalid/private.png)",
      "",
      "[Guide](guide.md)",
      "",
      "- Alpha",
      "- Beta",
      "",
      "operator prose ".repeat(3_200),
      "",
      "END-OF-DOCUMENT",
    ].join("\n");
    const unsavedMarkdown = storedMarkdown.replace(
      "Stored operator draft",
      "Unsaved operator draft",
    );

    try {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "sessions.files.get",
          "sessions.files.set",
        ],
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Review `notes/handoff.md` and compare `notes/plain.txt`.",
              },
            ],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "sessions.files.get": {
            cases: [
              {
                match: { path: "notes/handoff.md" },
                response: {
                  root: "/workspace",
                  sessionKey: "main",
                  file: {
                    content: storedMarkdown,
                    hash: "a".repeat(64),
                    kind: "read",
                    missing: false,
                    name: "handoff.md",
                    path: "notes/handoff.md",
                    workspacePath: "notes/handoff.md",
                  },
                },
              },
              {
                match: { path: "notes/guide.md" },
                response: {
                  root: "/workspace",
                  sessionKey: "main",
                  file: {
                    content: "# Linked guide\n",
                    kind: "read",
                    missing: false,
                    name: "guide.md",
                    path: "notes/guide.md",
                    workspacePath: "notes/guide.md",
                  },
                },
              },
              {
                match: { path: "notes/plain.txt" },
                response: {
                  root: "/workspace",
                  sessionKey: "main",
                  file: {
                    content: "plain text sibling\n",
                    kind: "read",
                    missing: false,
                    name: "plain.txt",
                    path: "notes/plain.txt",
                    workspacePath: "notes/plain.txt",
                  },
                },
              },
            ],
          },
        },
      });

      await page.goto(`${server.baseUrl}chat`);
      await page.locator('a.markdown-file-link[data-file-path="notes/handoff.md"]').click();
      const fileView = page.locator(".sidebar-file-view");
      await fileView.waitFor({ state: "visible" });
      await fileView.getByRole("button", { name: "Edit file" }).click();
      await fileView.locator(".cm-content").fill(unsavedMarkdown);
      await fileView.getByRole("button", { name: "Preview" }).click();

      const preview = fileView.locator(".sidebar-file-preview");
      await preview.getByRole("heading", { name: "Unsaved operator draft" }).waitFor();
      expect(await preview.getByRole("listitem").allTextContents()).toEqual(["Alpha", "Beta"]);
      expect(await preview.getByText("END-OF-DOCUMENT", { exact: true }).count()).toBe(1);
      expect(await preview.locator("img").count()).toBe(0);
      expect(remoteImageRequests).toEqual([]);
      expect(
        await fileView.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "01-running-control-ui-desktop-preview.png"),
      });

      await fileView.getByRole("button", { name: "Source" }).click();
      await expect
        .poll(() => fileView.locator(".cm-content").textContent())
        .toContain("Unsaved operator draft");
      await fileView.getByRole("button", { name: "Preview" }).click();
      await preview.getByRole("heading", { name: "Unsaved operator draft" }).waitFor();
      await page.setViewportSize({ height: 700, width: 390 });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "02-running-control-ui-mobile-preview.png"),
      });

      await preview.locator('a.markdown-file-link[data-file-path="guide.md"]').click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.get"))[1]?.params)
        .toMatchObject({ agentId: "main", path: "notes/guide.md", sessionKey: "main" });

      await page.locator('a.markdown-file-link[data-file-path="notes/plain.txt"]').click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.get"))[2]?.params)
        .toMatchObject({ agentId: "main", path: "notes/plain.txt", sessionKey: "main" });
      expect(await fileView.getByRole("button", { name: "Preview" }).count()).toBe(0);

      const receipt = {
        productHead,
        productionEntry: "running bundled Control UI /chat -> chat Markdown file link -> Review",
        readback: {
          heading: "Unsaved operator draft",
          largeDocumentRendered: true,
          listItems: ["Alpha", "Beta"],
          nonMarkdownModeControls: 0,
          relativeLinkRequest: {
            agentId: "main",
            path: "notes/guide.md",
            sessionKey: "main",
          },
          remoteImageElements: 0,
          remoteImageRequests,
          sourceDraftPreserved: true,
        },
      };
      fs.writeFileSync(path.join(artifactDir, "receipt.json"), JSON.stringify(receipt, null, 2));
    } finally {
      await context.close();
    }
  });
});
