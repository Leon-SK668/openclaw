package ai.openclaw.app.ui.design

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.uppercaseFirstGraphemeOrNull
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

internal const val compactBadgeProofRootDescription = "compact-badge-grapheme-proof-root"

internal data class CompactBadgeProofCase(
  val id: String,
  val label: String,
  val source: String,
  val expected: String,
) {
  val rendered: String = checkNotNull(source.uppercaseFirstGraphemeOrNull())
}

internal val compactBadgeProofCases =
  listOf(
    CompactBadgeProofCase(
      id = "compass",
      label = "Supplementary emoji",
      source = "\uD83E\uDDED scout",
      expected = "\uD83E\uDDED",
    ),
    CompactBadgeProofCase(
      id = "flag",
      label = "Regional indicator flag",
      source = "\uD83C\uDDFA\uD83C\uDDF8 team",
      expected = "\uD83C\uDDFA\uD83C\uDDF8",
    ),
    CompactBadgeProofCase(
      id = "zwj",
      label = "ZWJ emoji sequence",
      source = "\uD83D\uDC69\u200D\uD83D\uDCBB coder",
      expected = "\uD83D\uDC69\u200D\uD83D\uDCBB",
    ),
    CompactBadgeProofCase(
      id = "combining",
      label = "Combining mark",
      source = "e\u0301clair",
      expected = "E\u0301",
    ),
  ).onEach { proofCase ->
    check(proofCase.rendered == proofCase.expected) {
      "${proofCase.id}: expected ${proofCase.expected.codePointSummary()}, " +
        "got ${proofCase.rendered.codePointSummary()}"
    }
  }

class CompactBadgeProofActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      ClawDesignTheme(dark = true) {
        CompactBadgeProofScreen()
      }
    }
  }
}

@Composable
private fun CompactBadgeProofScreen() {
  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .background(ClawTheme.colors.canvas)
        .padding(horizontal = 24.dp, vertical = 32.dp)
        .semantics { contentDescription = compactBadgeProofRootDescription },
    verticalArrangement = Arrangement.Center,
  ) {
    Text(
      text = "Compact badge grapheme proof",
      style = ClawTheme.type.title,
      color = ClawTheme.colors.text,
    )
    Spacer(modifier = Modifier.height(6.dp))
    Text(
      text = "head ${BuildConfig.GIT_COMMIT.take(12)}",
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
    )
    Spacer(modifier = Modifier.height(24.dp))

    compactBadgeProofCases.forEachIndexed { index, proofCase ->
      CompactBadgeProofRow(proofCase)
      if (index != compactBadgeProofCases.lastIndex) {
        Spacer(modifier = Modifier.height(20.dp))
      }
    }
  }
}

@Composable
private fun CompactBadgeProofRow(proofCase: CompactBadgeProofCase) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    ClawTextBadge(
      text = proofCase.rendered,
      modifier =
        Modifier.semantics {
          contentDescription = "badge:${proofCase.id}:${proofCase.rendered}"
        },
    )
    Spacer(modifier = Modifier.width(16.dp))
    Column(modifier = Modifier.weight(1f)) {
      Text(
        text = proofCase.label,
        style = ClawTheme.type.body,
        color = ClawTheme.colors.text,
      )
      Spacer(modifier = Modifier.height(2.dp))
      Text(
        text = proofCase.rendered.codePointSummary(),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}

internal fun String.codePointSummary(): String =
  codePoints().toArray().joinToString(separator = " ") { codePoint ->
    "U+${codePoint.toString(16).uppercase().padStart(4, '0')}"
  }
