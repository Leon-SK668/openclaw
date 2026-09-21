import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalWindowScreenshotProofTests {
    private static let command = "/bin/sh -lc pwd"
    private static let rawSession = "  agent:main:telegram:dm:12345  "
    private static let expectedSession = "agent:main:telegram:dm:12345"

    @Test func `capture the running approval window with identical input`() async throws {
        _ = AppKitTestSupport.application
        let panel = ExecApprovalsPromptPresenter.buildPanel(
            ExecApprovalPromptRequest(command: Self.command, sessionKey: Self.rawSession),
            onDecision: { _ in })
        defer { panel.close() }
        NSApp.activate(ignoringOtherApps: true)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        let content = try #require(panel.contentView)
        content.layoutSubtreeIfNeeded()
        panel.displayIfNeeded()

        // Materialize the actual SwiftUI accessibility tree while AppKit remains
        // responsive. The labels are a control, not a replacement for screenshot pixels.
        let labels = try await self.accessibilityLabels(in: panel)
        try #require(labels.contains { $0.contains("Allow Once") })
        try #require(panel.isVisible)
        try #require(panel.occlusionState.contains(.visible))
        let windowID = CGWindowID(panel.windowNumber)
        let windows = try #require(
            CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]])
        let window = try #require(windows.first { ($0[kCGWindowNumber as String] as? UInt32) == windowID })
        try #require((window[kCGWindowOwnerPID as String] as? Int32) == ProcessInfo.processInfo.processIdentifier)
        try #require((window[kCGWindowIsOnscreen as String] as? Bool) == true)

        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("pr132503-native-window-output", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let output = directory.appendingPathComponent("approval-window.png")
        try #require(!FileManager.default.fileExists(atPath: output.path))

        // Capture only this visible native window through macOS, never an offscreen
        // NSView bitmap or another application's desktop. No TCC/permission changes.
        let captureStatus = try await Task.detached {
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l\(windowID)", output.path]
            try capture.run()
            capture.waitUntilExit()
            return capture.terminationStatus
        }.value
        try #require(captureStatus == 0, "macOS window capture failed; no render fallback is allowed")
        let png = try Data(contentsOf: output)
        let bitmap = try #require(NSBitmapImageRep(data: png))
        try #require(bitmap.pixelsWide > 0 && bitmap.pixelsHigh > 0)
        let hasSessionLabel = labels.contains { $0.contains("Session:") }
        let hasExpectedSession = labels.contains { $0.contains(Self.expectedSession) }
        let observation: [String: Any] = [
            "captureKind": "macOS screencapture of the visible native approval window",
            "captureAPI": "/usr/sbin/screencapture -x -o -l<owned-window-id>",
            "command": Self.command,
            "rawSession": Self.rawSession,
            "expectedSession": Self.expectedSession,
            "windowID": windowID,
            "windowVisible": panel.isVisible,
            "windowOnScreen": true,
            "windowOwnedByTestProcess": true,
            "windowBounds": window[kCGWindowBounds as String] ?? [:],
            "accessibilityHasAllowOnce": true,
            "accessibilityHasSessionLabel": hasSessionLabel,
            "accessibilityHasExpectedSession": hasExpectedSession,
            "pixelWidth": bitmap.pixelsWide,
            "pixelHeight": bitmap.pixelsHigh,
            "captureExitCode": captureStatus,
            "visualInspection": "pending; inspect the original PNG before publishing",
        ]
        let data = try JSONSerialization.data(withJSONObject: observation, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: directory.appendingPathComponent("observation.json"))
        print("Native window captured: allowOnce=true sessionLabel=\(hasSessionLabel) sessionValue=\(hasExpectedSession)")
    }

    private func accessibilityLabels(in root: AnyObject) async throws -> [String] {
        let result = await Task.detached {
            let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
            var windows: CFTypeRef?
            return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
        }.value
        try #require(result == .success)
        var labels: [String] = []
        var visited = Set<ObjectIdentifier>()
        func visit(_ element: AnyObject) {
            guard visited.insert(ObjectIdentifier(element)).inserted else { return }
            labels.append(contentsOf: [element.accessibilityLabel?(), element.accessibilityTitle?()].compactMap(\.self))
            for child in element.accessibilityChildren?() ?? [] {
                visit(child as AnyObject)
            }
        }
        visit(root)
        return labels
    }
}
