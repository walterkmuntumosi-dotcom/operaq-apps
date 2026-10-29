# OperaQ phone apps · App Store and Google Play

Every OperaQ company can publish its own phone apps under its own name, icon and store accounts:

| App | Opens | Who |
|---|---|---|
| Customer app | Deliver booking (`/deliver/book/<slug>`), otherwise the company's OperaQ website | the company's customers |
| Driver app | `/deliver/app/driver/<slug>`: sign in with a code from the dispatcher, then the driver app | the company's drivers (Deliver) |
| Staff app | My Work (`/workspace/workforce/my`) | the company's team (Workforce) |

Apple (guideline 4.2.6) only accepts apps made from a template when the business itself submits them, so each company
uses **its own** Apple Developer account ($99/year) and Google Play developer account ($25 once). OperaQ builds, signs and
uploads; the company connects its keys in the back office (Workspace › Phone apps). Powered by OPERAQ.

## How a build runs
1. Company taps **Build** in Phone apps → the OperaQ server stores a waiting build and starts
   `.github/workflows/operaq-app-build.yml` (workflow_dispatch with the build id). If the server has no GitHub token,
   the workflow picks the build up within the hour (hourly schedule).
2. `runner.mjs claim/get` takes the build and its sealed keys from the server (`/api/operaq/build-runner`, bearer
   `OPERAQ_BUILD_TOKEN`; secrets are masked in the log).
3. `prepare.mjs` turns `shell/` (Capacitor 8) into the company's app: name, app id, icon, colours, version, permissions
   with plain-language reasons, export compliance.
4. Android (`build-android.sh`, GitHub Linux): `.aab` signed with the company's upload key (made on the first build and
   kept sealed by OperaQ, never replaced), sent back for download, uploaded to the internal track with the company's
   service account. The very first upload of a new app must be done by hand in Play Console (Google's rule).
5. iPhone (`build-ios.sh` + `fastlane/Fastfile`, GitHub Mac): registers the bundle ID, creates or reuses the company's
   distribution certificate (kept sealed by OperaQ), makes the profile, builds, uploads to TestFlight with the
   company's App Store Connect key (Admin). The company creates the app record once in App Store Connect (Apple's rule).
6. Status goes back to the server and shows in Phone apps.

## One-time setup (owner)
- Run `bash operaq-apps/setup-builds.sh` from the private ops repo on the Mac once. It sets this repo's GitHub secret
  `OPERAQ_BUILD_TOKEN` = the same value as the server env `OPERAQ_BUILD_RUNNER_TOKEN` (staging and live).
- Optional, server env `OPERAQ_BUILD_GITHUB_TOKEN`: a fine-grained GitHub token with **Actions: read and write** on this repo
  only (lets the server start builds at once; without it builds start within about 15 minutes).

## Public repo
This repo is public on purpose: GitHub Actions minutes (Linux and Mac) are free and unlimited on public repos, so a
company's builds never cost OperaQ anything. That only works safely because:
- Nothing secret is in the code. The only secret is `OPERAQ_BUILD_TOKEN` (a GitHub encrypted secret, never given to pull
  requests or forks). Company keys (Apple, Google, signing) live sealed on the OperaQ server and reach a build only
  through `runner.mjs get`, which masks them **and** everything that names the company (`identifiersOf`) before anything prints.
- Builds never use `actions/upload-artifact` or caches that hold a company's files: the finished app goes back to the
  OperaQ server (`runner.mjs send`).
- Only people with write access can start a build (`workflow_dispatch`); a pull request only runs the self-test.
When you add a new key or identifier to the job, add it to `secretsOf` or `identifiersOf` in the same change.

## Checks
`node --test tests/*.test.mjs` and, on every push or pull request, a self-test build of both shells (no keys, nothing uploaded).
