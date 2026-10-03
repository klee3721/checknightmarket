# Codex handoff: Night Market Checker

Read `README.md` first, then read the platform handoff that applies:

- `MACBOOK_SETUP.md` on macOS.
- `WINDOWS_SETUP.md` on Windows.

## Purpose

This is a local Node.js dashboard that uses `playwright-core` with persistent Chrome profiles. It imports Riot credentials from `.xlsx`/`.csv`, logs into Riot, obtains the localhost redirect URL through Menzu, submits it to Menzu, opens and reveals Night Market cards, captures an image, deletes the archived Menzu account, and clears the Riot session.

## Important files

- `server.js`: local-only Express API and SSE state stream.
- `src/automation.js`: browser workers and the end-to-end workflow.
- `src/account-store.js`: Excel/CSV parsing and in-memory queue.
- `src/result-store.js`: screenshots and `results.csv`.
- `src/utils.js`: platform-aware Chrome/Edge detection.
- `config.json`: all volatile Riot/Menzu selectors and timeouts.
- `public/`: dashboard UI.

## macOS notes

- Chrome should resolve to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Override with `NIGHTMARKET_BROWSER` when needed.
- Start with `zsh start-mac.command` or `npm ci && npm start`.
- Windows Chrome cookies/profile data must not be migrated. Create fresh profiles and sign in to Menzu again.
- Do not hard-code Windows paths. Excel files are uploaded through the dashboard.

## Windows notes

- Browser executable discovery already supports standard Chrome and Edge install paths in `src/utils.js`.
- The current visible Riot token capture still calls macOS AppleScript in `regularChromeTabUrls()` and must be replaced or adapted on Windows before the real workflow can run there. Follow `WINDOWS_SETUP.md`.
- Keep the token validation strict: only accept `http://localhost/redirect#...` containing `access_token`.
- Do not migrate `profiles/`, `runtime/`, browser cookies, or token data between macOS and Windows.
- Keep `start.bat` and Windows cleanup scoped to this project. Never kill every Chrome, Edge, Node, PowerShell, or Command Prompt process on the machine.

## Known current behavior

- Public Riot login selectors were verified in October 2026.
- Post-login Menzu archive/Night Market selectors may require calibration using a real authenticated Menzu session. They are intentionally isolated in `config.json`.
- Riot has shown CAPTCHA/risk checks and can return a generic invalid-credentials message during automated login even when credentials work manually.
- Do not implement CAPTCHA bypass, fingerprint spoofing, proxy rotation, or stealth measures. Prefer a human-assisted login mode: populate fields, pause before submit/CAPTCHA/MFA, then resume the Menzu workflow after the user completes authentication.
- Token URLs and passwords must never be logged, returned by public state APIs, stored in results, or included in screenshots/previews.

## Required verification

Run before delivery:

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
```

For a UI smoke test, start the server and confirm `http://127.0.0.1:3210` loads without browser console errors. Test the real workflow with one account in visible-browser mode before enabling concurrency.

## Packaging rules

Never package or commit `node_modules/`, `profiles/`, `runtime/`, `results/`, account spreadsheets, passwords, cookies, tokens, or browser data. Only source, tests, lockfiles, documentation, and dummy samples belong in a distributable archive.
