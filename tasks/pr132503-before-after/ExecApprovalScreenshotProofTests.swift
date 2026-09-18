import AppKit
import Foundation
import Testing
import Vision
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalScreenshotProofTests {
    private static let command = "/bin/sh -lc pwd"
    private static let rawSession = "  agent:main:telegram:dm:12345  "
    private static let expectedSession = "agent:main:telegram:dm:12345"
    private static let captureKind =
        "rendered native panel content view, not a desktop or full-window screenshot"

    @Test func `capture fixed nonblank session approval content view`() throws {
        _ = AppKitTestSupport.application
        let panel = ExecApprovalsPromptPresenter.buildPanel(
            ExecApprovalPromptRequest(
                command: Self.command,
                sessionKey: Self.rawSession),
            onDecision: { _ in })
        defer { panel.close() }

        NSApp.activate(ignoringOtherApps: true)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        panel.displayIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        #expect(panel.isVisible)

        let content = try #require(panel.contentView)
        content.layoutSubtreeIfNeeded()
        content.displayIfNeeded()
        let bitmap = try #require(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: bitmap)
        let image = try #require(bitmap.cgImage)

        let recognizedText = try self.recognizedText(in: image)
        let hasAllowOnce = recognizedText.contains("Allow Once")
        let hasSessionLabel = recognizedText.contains("Session")
        let hasExpectedSession = recognizedText.contains(Self.expectedSession)

        // This same-image control must pass for both revisions. Session visibility is
        // recorded for the workflow's outer before/after acceptance instead.
        #expect(hasAllowOnce)
        try self.writeEvidence(
            image: image,
            recognizedText: recognizedText,
            hasAllowOnce: hasAllowOnce,
            hasSessionLabel: hasSessionLabel,
            hasExpectedSession: hasExpectedSession)
        print(
            "Approval content-view observation: allowOnce=\(hasAllowOnce) " +
                "sessionLabel=\(hasSessionLabel) expectedSession=\(hasExpectedSession)")
    }

    private func recognizedText(in image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? [])
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    private func writeEvidence(
        image: CGImage,
        recognizedText: String,
        hasAllowOnce: Bool,
        hasSessionLabel: Bool,
        hasExpectedSession: Bool) throws
    {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("pr132503-before-after-output", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true)

        let bitmap = NSBitmapImageRep(cgImage: image)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: directory.appendingPathComponent("approval-content-view.png"))

        let observation: [String: Any] = [
            "captureKind": Self.captureKind,
            "command": Self.command,
            "rawSession": Self.rawSession,
            "expectedSession": Self.expectedSession,
            "recognizedText": recognizedText,
            "hasAllowOnce": hasAllowOnce,
            "hasSessionLabel": hasSessionLabel,
            "hasExpectedSession": hasExpectedSession,
            "pixelWidth": image.width,
            "pixelHeight": image.height,
        ]
        let data = try JSONSerialization.data(
            withJSONObject: observation,
            options: [.prettyPrinted, .sortedKeys])
        try data.write(to: directory.appendingPathComponent("approval-content-view-observation.json"))
    }
}
