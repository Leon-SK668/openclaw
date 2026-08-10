// Searxng helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/extension-shared";
import { normalizeSecretInput, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";

type SearxngPluginConfig = {
  webSearch?: {
    baseUrl?: unknown;
    categories?: string;
    language?: string;
  };
};

function resolveConfiguredBaseUrl(
  value: unknown,
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const resolved = resolveSecretInputString({
    value,
    path: "plugins.entries.searxng.config.webSearch.baseUrl",
    defaults: config?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return normalizeSecretInput(resolved.value);
  }
  if (resolved.status !== "configured_unavailable" || resolved.ref.source !== "env") {
    return undefined;
  }
  // Read-only plugin resolution may inspect env only through the configured provider contract.
  // A denial still falls through to the shipped ambient SEARXNG_BASE_URL path below.
  if (
    !canResolveEnvSecretRefInReadOnlyPath({
      cfg: config,
      provider: resolved.ref.provider,
      id: resolved.ref.id,
    })
  ) {
    return undefined;
  }
  return normalizeSecretInput(env[resolved.ref.id]);
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/u, "") || undefined;
}

function resolveSearxngWebSearchConfig(
  config?: OpenClawConfig,
): SearxngPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.searxng?.config as SearxngPluginConfig | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveSearxngBaseUrl(
  config?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const webSearch = resolveSearxngWebSearchConfig(config);
  return (
    normalizeBaseUrl(resolveConfiguredBaseUrl(webSearch?.baseUrl, config, env)) ??
    normalizeBaseUrl(normalizeSecretInput(env.SEARXNG_BASE_URL))
  );
}

export function resolveSearxngCategories(config?: OpenClawConfig): string | undefined {
  return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.categories);
}

export function resolveSearxngLanguage(config?: OpenClawConfig): string | undefined {
  return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.language);
}
