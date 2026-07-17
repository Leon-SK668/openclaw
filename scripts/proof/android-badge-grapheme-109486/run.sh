#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: run.sh <target-root> <harness-root> <expected-head-sha> <artifact-dir>" >&2
  exit 2
fi

target_root="$(cd "$1" && pwd)"
harness_root="$(cd "$2" && pwd)"
expected_head="$3"
artifact_dir="$4"
proof_dir="$harness_root/scripts/proof/android-badge-grapheme-109486"
test_class="ai.openclaw.app.ui.design.CompactBadgeProofTest"

activity_rel="apps/android/app/src/playDebug/java/ai/openclaw/app/ui/design/CompactBadgeProofActivity.kt"
test_rel="apps/android/app/src/androidTest/java/ai/openclaw/app/ui/design/CompactBadgeProofTest.kt"
manifest_rel="apps/android/app/src/playDebug/AndroidManifest.xml"
injected_paths=("$activity_rel" "$test_rel" "$manifest_rel")
can_clean=0

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$can_clean" -eq 1 ]]; then
    for rel in "${injected_paths[@]}"; do
      rm -f "$target_root/$rel"
    done
  fi
  if [[ -n "$(git -C "$target_root" status --porcelain=v1 --untracked-files=all)" ]]; then
    echo "target checkout is not clean after proof cleanup" >&2
    git -C "$target_root" status --short --untracked-files=all >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ ! "$expected_head" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected head must be a full lowercase commit SHA" >&2
  exit 2
fi
if [[ "$(git -C "$target_root" rev-parse HEAD)" != "$expected_head" ]]; then
  echo "target checkout is not at expected PR head $expected_head" >&2
  exit 1
fi
if [[ -n "$(git -C "$target_root" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "target checkout must start clean" >&2
  git -C "$target_root" status --short --untracked-files=all >&2
  exit 1
fi

for rel in "${injected_paths[@]}"; do
  if [[ -e "$target_root/$rel" ]]; then
    echo "refusing to overwrite target path: $rel" >&2
    exit 1
  fi
done
can_clean=1

mkdir -p \
  "$(dirname "$target_root/$activity_rel")" \
  "$(dirname "$target_root/$test_rel")" \
  "$(dirname "$target_root/$manifest_rel")" \
  "$artifact_dir"
cp "$proof_dir/CompactBadgeProofActivity.kt" "$target_root/$activity_rel"
cp "$proof_dir/CompactBadgeProofTest.kt" "$target_root/$test_rel"
cp "$proof_dir/AndroidManifest.xml" "$target_root/$manifest_rel"

expected_untracked="$(printf '%s\n' "${injected_paths[@]}" | sort)"
actual_untracked="$(git -C "$target_root" ls-files --others --exclude-standard | sort)"
if [[ "$actual_untracked" != "$expected_untracked" ]]; then
  echo "target injection differs from the three reviewed proof files" >&2
  diff -u <(printf '%s\n' "$expected_untracked") <(printf '%s\n' "$actual_untracked") >&2 || true
  exit 1
fi
git -C "$target_root" diff --exit-code

{
  echo "expected_head=$expected_head"
  echo "actual_head=$(git -C "$target_root" rev-parse HEAD)"
  echo "device=$(adb shell getprop ro.product.model | tr -d '\r')"
  echo "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "fingerprint=$(adb shell getprop ro.build.fingerprint | tr -d '\r')"
} | tee "$artifact_dir/environment.txt"

adb logcat -c
set +e
(
  cd "$target_root/apps/android"
  ./gradlew --no-daemon --stacktrace \
    :app:connectedPlayDebugAndroidTest \
    "-Pandroid.testInstrumentationRunnerArguments.class=$test_class"
) 2>&1 | tee "$artifact_dir/gradle.log"
gradle_status=${PIPESTATUS[0]}
set -e

adb logcat -d > "$artifact_dir/logcat.txt" || true
reports_dir="$target_root/apps/android/app/build/reports/androidTests/connected"
results_dir="$target_root/apps/android/app/build/outputs/androidTest-results/connected"
if [[ -d "$reports_dir" ]]; then
  cp -R "$reports_dir" "$artifact_dir/connected-report"
fi
if [[ -d "$results_dir" ]]; then
  cp -R "$results_dir" "$artifact_dir/connected-results"
fi
if [[ "$gradle_status" -ne 0 ]]; then
  echo "connected Android proof failed with status $gradle_status" >&2
  exit "$gradle_status"
fi

package_name="ai.openclaw.app"
external_storage="$(adb shell 'printf %s "$EXTERNAL_STORAGE"' | tr -d '\r')"
test -n "$external_storage"
artifact_device_dir="$external_storage/Android/data/$package_name/files"
for artifact in \
  compact-badge-grapheme-proof.png \
  compact-badge-grapheme-proof.xml \
  compact-badge-grapheme-proof.json; do
  adb exec-out cat "$artifact_device_dir/$artifact" > "$artifact_dir/$artifact"
  test -s "$artifact_dir/$artifact"
done

node "$proof_dir/verify-proof.mjs" \
  "$artifact_dir/compact-badge-grapheme-proof.png" \
  "$artifact_dir/compact-badge-grapheme-proof.xml" \
  "$artifact_dir/compact-badge-grapheme-proof.json" \
  "$expected_head" \
  | tee "$artifact_dir/verification.txt"

git -C "$target_root" diff --exit-code
actual_untracked="$(git -C "$target_root" ls-files --others --exclude-standard | sort)"
test "$actual_untracked" = "$expected_untracked"

for rel in "${injected_paths[@]}"; do
  rm -f "$target_root/$rel"
done
can_clean=0
test -z "$(git -C "$target_root" status --porcelain=v1 --untracked-files=all)"
