package ai.openclaw.app.ui.design

import ai.openclaw.app.BuildConfig
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
internal class CompactBadgeProofTest {
  @Test
  fun rendersWholeGraphemesInProductionBadges() {
    assertEquals(EXPECTED_HEAD_SHA, BuildConfig.GIT_COMMIT)
    compactBadgeProofCases.forEach { proofCase ->
      assertEquals(proofCase.id, proofCase.expected, proofCase.rendered)
      assertFalse(proofCase.rendered.contains(REPLACEMENT_CHARACTER))
    }

    ActivityScenario.launch(CompactBadgeProofActivity::class.java).use {
      val instrumentation = InstrumentationRegistry.getInstrumentation()
      val device = UiDevice.getInstance(instrumentation)
      val publicProofDir =
        requireNotNull(InstrumentationRegistry.getArguments().getString(PROOF_DIR_ARGUMENT)) {
          "public proof directory instrumentation argument unavailable"
        }
      assertTrue(
        "public proof directory must use shared Download storage",
        publicProofDir.startsWith("/sdcard/Download/"),
      )
      val targetFiles =
        requireNotNull(instrumentation.targetContext.getExternalFilesDir(null)) {
          "target external proof directory unavailable"
        }
      assertTrue(
        "failed to create target proof directory",
        targetFiles.isDirectory || targetFiles.mkdirs(),
      )
      device.executeShellCommand("rm -rf $publicProofDir")
      assertTrue(
        "stale public proof directory survived cleanup",
        device.executeShellCommand("ls -d $publicProofDir").isBlank(),
      )
      device.executeShellCommand("mkdir -p $publicProofDir")
      assertEquals(
        "public proof directory was not created",
        publicProofDir,
        device.executeShellCommand("ls -d $publicProofDir").trim(),
      )

      assertTrue(
        "proof root never became visible",
        device.wait(Until.hasObject(By.desc(compactBadgeProofRootDescription)), UI_TIMEOUT_MS),
      )
      device.waitForIdle()
      SystemClock.sleep(FONT_SETTLE_MS)

      val replacementNodeCount =
        device.findObjects(By.textContains(REPLACEMENT_CHARACTER)).size +
          device.findObjects(By.descContains(REPLACEMENT_CHARACTER)).size
      assertEquals("replacement glyph exposed in UI semantics", 0, replacementNodeCount)

      val screenshot = assertNotNullBitmap(instrumentation.uiAutomation.takeScreenshot())
      val screenshotFile = File(targetFiles, SCREENSHOT_FILE)
      FileOutputStream(screenshotFile).use { output ->
        assertTrue("failed to encode proof screenshot", screenshot.compress(Bitmap.CompressFormat.PNG, 100, output))
      }

      val caseMetrics = JSONArray()
      compactBadgeProofCases.forEach { proofCase ->
        val description = "badge:${proofCase.id}:${proofCase.rendered}"
        val badge = device.wait(Until.findObject(By.desc(description)), UI_TIMEOUT_MS)
        assertNotNull("missing badge semantics for ${proofCase.id}", badge)

        val bounds = requireNotNull(badge).visibleBounds
        assertTrue("${proofCase.id} badge has no width", bounds.width() > 0)
        assertTrue("${proofCase.id} badge has no height", bounds.height() > 0)
        assertTrue(
          "${proofCase.id} badge bounds are unexpectedly non-square: $bounds",
          kotlin.math.abs(bounds.width() - bounds.height()) <= max(2, bounds.width() / 10),
        )

        val pixels = analyzeBadgePixels(screenshot, bounds)
        assertTrue("${proofCase.id} badge has too few colors", pixels.uniqueColors >= MIN_BADGE_COLORS)
        assertTrue(
          "${proofCase.id} badge has no detectable foreground pixels",
          pixels.nonDominantPixels >= max(MIN_FOREGROUND_PIXELS, pixels.pixelCount / 200),
        )

        caseMetrics.put(
          JSONObject()
            .put("id", proofCase.id)
            .put("source", proofCase.source)
            .put("rendered", proofCase.rendered)
            .put("expected", proofCase.expected)
            .put("codePoints", proofCase.rendered.codePointSummary())
            .put("contentDescription", description)
            .put("left", bounds.left)
            .put("top", bounds.top)
            .put("right", bounds.right)
            .put("bottom", bounds.bottom)
            .put("width", bounds.width())
            .put("height", bounds.height())
            .put("pixelCount", pixels.pixelCount)
            .put("uniqueColors", pixels.uniqueColors)
            .put("dominantPixels", pixels.dominantPixels)
            .put("nonDominantPixels", pixels.nonDominantPixels),
        )
      }

      val hierarchyFile = File(targetFiles, HIERARCHY_FILE)
      device.dumpWindowHierarchy(hierarchyFile)
      val hierarchy = hierarchyFile.readText()
      assertFalse("hierarchy is not valid Unicode", hierarchy.contains(REPLACEMENT_CHARACTER))

      val metrics =
        JSONObject()
          .put("head", BuildConfig.GIT_COMMIT)
          .put("sdk", Build.VERSION.SDK_INT)
          .put("model", Build.MODEL)
          .put("fingerprint", Build.FINGERPRINT)
          .put("screenWidth", screenshot.width)
          .put("screenHeight", screenshot.height)
          .put("screenUniqueColors", countSampledColors(screenshot))
          .put("replacementNodeCount", replacementNodeCount)
          .put("cases", caseMetrics)
      File(targetFiles, METRICS_FILE).writeText(metrics.toString(2))

      listOf(screenshotFile, hierarchyFile, File(targetFiles, METRICS_FILE)).forEach { artifact ->
        val publicArtifact = "$publicProofDir/${artifact.name}"
        device.executeShellCommand("cp ${artifact.absolutePath} $publicArtifact")
        val exportedSize =
          device.executeShellCommand("stat -c %s $publicArtifact").trim().toLongOrNull()
        assertNotNull("public proof artifact was not exported: ${artifact.name}", exportedSize)
        assertTrue(
          "public proof artifact is empty: ${artifact.name}",
          requireNotNull(exportedSize) > 0,
        )
      }
    }
  }

  private fun analyzeBadgePixels(bitmap: Bitmap, rawBounds: Rect): PixelMetrics {
    val bounds = Rect(rawBounds)
    assertTrue("badge is outside screenshot", bounds.intersect(0, 0, bitmap.width, bitmap.height))
    // Sample the central half so the circular border/corners cannot masquerade as glyph pixels.
    val inset = max(2, minOf(bounds.width(), bounds.height()) / 4)
    bounds.inset(inset, inset)
    assertTrue("badge inner pixel region is empty", bounds.width() > 0 && bounds.height() > 0)

    val counts = HashMap<Int, Int>()
    for (y in bounds.top until bounds.bottom) {
      for (x in bounds.left until bounds.right) {
        val color = bitmap.getPixel(x, y)
        counts[color] = (counts[color] ?: 0) + 1
      }
    }
    val pixelCount = bounds.width() * bounds.height()
    val dominantPixels = counts.values.maxOrNull() ?: 0
    return PixelMetrics(
      pixelCount = pixelCount,
      uniqueColors = counts.size,
      dominantPixels = dominantPixels,
      nonDominantPixels = pixelCount - dominantPixels,
    )
  }

  private fun countSampledColors(bitmap: Bitmap): Int {
    val colors = HashSet<Int>()
    for (y in 0 until bitmap.height step SCREEN_SAMPLE_STEP) {
      for (x in 0 until bitmap.width step SCREEN_SAMPLE_STEP) {
        colors.add(bitmap.getPixel(x, y))
      }
    }
    assertTrue("screenshot appears blank", colors.size >= MIN_SCREEN_COLORS)
    return colors.size
  }

  private fun assertNotNullBitmap(bitmap: Bitmap?): Bitmap {
    assertNotNull("UiAutomation returned no screenshot", bitmap)
    return requireNotNull(bitmap)
  }

  private data class PixelMetrics(
    val pixelCount: Int,
    val uniqueColors: Int,
    val dominantPixels: Int,
    val nonDominantPixels: Int,
  )

  private companion object {
    const val EXPECTED_HEAD_SHA = "22f2be63225c5ac907c1b58050e59f4e964e0558"
    const val SCREENSHOT_FILE = "compact-badge-grapheme-proof.png"
    const val HIERARCHY_FILE = "compact-badge-grapheme-proof.xml"
    const val METRICS_FILE = "compact-badge-grapheme-proof.json"
    const val PROOF_DIR_ARGUMENT = "proofDir"
    const val UI_TIMEOUT_MS = 15_000L
    const val FONT_SETTLE_MS = 1_000L
    const val SCREEN_SAMPLE_STEP = 4
    const val MIN_SCREEN_COLORS = 16
    const val MIN_BADGE_COLORS = 4
    const val MIN_FOREGROUND_PIXELS = 12
    const val REPLACEMENT_CHARACTER = "\uFFFD"
  }
}
