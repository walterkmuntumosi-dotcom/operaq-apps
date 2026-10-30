#!/usr/bin/env bash
# OPERAQ STORE APPS · build one company's Android app (.aab), sign it with the company's upload key, upload it to Google Play.
#   API=https://operaq.app JOB_ID=<id> OPERAQ_BUILD_TOKEN=… bash build-android.sh
# SELF_TEST=1 builds self-test-android.json (SELF_TEST_JOB=self-test-android-push.json: with notifications) unsigned without any server (the push / pull request check).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${RUNNER_TEMP:-/tmp}/operaq-app"; rm -rf "$work"; mkdir -p "$work"
job="$work/job.json"; app="$work/app"
r() { node "$here/runner.mjs" "$@"; }
fail() { [ -n "${SELF_TEST:-}" ] || r status "$API" "$JOB_ID" failed "$1" || true; echo "FAILED: $1"; exit 1; }

if [ -n "${SELF_TEST:-}" ]; then cp "$here/${SELF_TEST_JOB:-self-test-android.json}" "$job"; else
  r get "$API" "$JOB_ID" "$job"
  r status "$API" "$JOB_ID" building "Building the Android app"
fi
jq() { node -e "const j=require('$job');const v=$1;process.stdout.write(v==null?'':String(v))"; }

node "$here/prepare.mjs" "$job" "$app" || fail "The app could not be prepared (see the build log)."
cd "$app/android"
chmod +x gradlew
./gradlew --no-daemon -q bundleRelease || fail "Android build failed (see the build log)."
aab="$app/android/app/build/outputs/bundle/release/app-release.aab"
[ -f "$aab" ] || fail "Android build made no .aab"

if [ -n "${SELF_TEST:-}" ]; then ls -l "$aab"; echo "SELF TEST OK"; exit 0; fi

# The company's upload key: made on the first build and kept (sealed) by OperaQ; never replaced.
ks="$work/upload.jks"
if [ -n "$(jq 'j.android&&j.android.keystore&&j.android.keystore.base64')" ]; then
  jq 'j.android.keystore.base64' | base64 -d > "$ks"
  pw="$(jq 'j.android.keystore.password')"; alias="$(jq 'j.android.keystore.alias')"
else
  pw="$(node -e "process.stdout.write(require('crypto').randomBytes(18).toString('base64url'))")"; alias=upload
  echo "::add-mask::$pw"
  keytool -genkeypair -keystore "$ks" -alias "$alias" -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$pw" -keypass "$pw" -dname "CN=$(jq 'j.appName.replace(/[,=+<>#;"\\\\]/g," ")'), O=Powered by OPERAQ" >/dev/null 2>&1
  node -e "process.stdout.write(JSON.stringify({base64:require('fs').readFileSync('$ks').toString('base64'),password:process.argv[1],alias:'$alias'}))" "$pw" > "$work/keystore.json"
  r send "$API" "$JOB_ID" keystore "$work/keystore.json" || fail "OperaQ could not keep the new upload key; nothing was uploaded."
fi
jarsigner -keystore "$ks" -storepass "$pw" -sigalg SHA256withRSA -digestalg SHA-256 "$aab" "$alias" >/dev/null || fail "Signing the app failed."
cp "$aab" "$work/app.aab"
r send "$API" "$JOB_ID" artifact "$work/app.aab" || true

if [ -z "$(jq 'j.android&&j.android.serviceAccountJson')" ]; then
  r status "$API" "$JOB_ID" needs_first_upload "Built. Download it in Phone apps and upload it once in Play Console › Test and release › Internal testing."
  exit 0
fi
cd "$work"
r play "$job" "$work/app.aab" || fail "Uploading to Google Play failed."
st="$(node -e "process.stdout.write(require('$work/play-result.json').status)")"
msg="$(node -e "process.stdout.write(require('$work/play-result.json').message)")"
r status "$API" "$JOB_ID" "$st" "$msg"
