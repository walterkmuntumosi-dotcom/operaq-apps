#!/usr/bin/env bash
# OPERAQ STORE APPS · build one company's iPhone app on GitHub's Mac and send it to TestFlight (fastlane/Fastfile).
#   API=https://operaq.app JOB_ID=<id> OPERAQ_BUILD_TOKEN=… bash build-ios.sh
# SELF_TEST=1 builds self-test-ios.json for iPhone, unsigned, without any server.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${RUNNER_TEMP:-/tmp}/operaq-app"; rm -rf "$work"; mkdir -p "$work"
job="$work/job.json"; app="$work/app"
r() { node "$here/runner.mjs" "$@"; }
fail() { [ -n "${SELF_TEST:-}" ] || r status "$API" "$JOB_ID" failed "$1" || true; echo "FAILED: $1"; exit 1; }

if [ -n "${SELF_TEST:-}" ]; then cp "$here/self-test-ios.json" "$job"; else
  r get "$API" "$JOB_ID" "$job"
  r status "$API" "$JOB_ID" building "Building the iPhone app"
fi
node "$here/prepare.mjs" "$job" "$app" || fail "The app could not be prepared (see the build log)."

if [ -n "${SELF_TEST:-}" ]; then
  xcodebuild -project "$app/ios/App/App.xcodeproj" -scheme App -configuration Release -sdk iphoneos \
    -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build | tail -5
  echo "SELF TEST OK"; exit 0
fi

cd "$here"
rm -f ios-result.json
OPERAQ_JOB="$job" APP_DIR="$app" bundle exec fastlane ios store || true
[ -f ios-result.json ] || fail "The iPhone build stopped early (see the build log)."
node -e "const r=require('./ios-result.json'); if (r.signing) require('fs').writeFileSync('$work/signing.json', JSON.stringify(r.signing))"
if [ -f "$work/signing.json" ]; then r send "$API" "$JOB_ID" ios-signing "$work/signing.json" || true; fi
st="$(node -e "process.stdout.write(require('./ios-result.json').status)")"
msg="$(node -e "process.stdout.write(require('./ios-result.json').message)")"
r status "$API" "$JOB_ID" "$st" "$msg"
[ "$st" != failed ]
