# Floreo Till for Windows, macOS and Linux

The till as a desktop app (Electron). The till itself is the web till (`web/src/pos`), bundled with the app and served from `app://pos/`. The app adds:

- **Network receipt printers:** ESC/POS straight to the printer's IP address (port 9100), only on the local network. It can also kick the cash drawer plugged into the printer.
- **Installed (USB) printers:** prints without a dialog, sized to the roll (58 or 80 mm).
- **Customer display:** a full-screen window on a second monitor, showing the items, the total and the change.
- **Storage:** the till's token, encrypted with the operating system's keychain (`safeStorage`).

## Run it

```bash
npm run web:build            # at the repository root: builds web/dist (with the till page)
cd apps/desktop
npm install
npm start                    # copies the till into web/ and opens the app
```

While working on it, skip the build: at the repository root,

```bash
npm run till:dev             # the app, with its screens straight from the source; a change shows at once
```

It keeps its own data folder ("Floreo Till (dev)"), so it does not touch an installed till's pairing. Pair it with a server you have running (the demo, for one); `VITE_TILL_SERVER=http://localhost:4300 npm run till:dev` pre-fills the address.

Set `VITE_TILL_SERVER=https://app.example.bz` when building the web app to pre-fill the server address in the pairing screen.

## Installers

```bash
npm run dist:win             # Windows installer (NSIS) and its update files, in release/
npm run dist:mac             # macOS .dmg and .zip (build on a Mac)
npm run dist:linux           # AppImage and .deb
```

The settings are in `electron-builder.config.cjs`; anything secret comes from the environment.

### Signing (Windows)

An unsigned installer works, but Windows warns that the publisher is unknown, and installed tills
cannot check who made an update. For businesses, sign it. Since 2023 code-signing keys live on a
hardware token or in a cloud service, not in a file, so there are two ways in:

| You have | Set | Notes |
|---|---|---|
| A USB token, or a cloud service that puts its certificate in the Windows certificate store (DigiCert KeyLocker, SSL.com eSigner…) | `WIN_SIGN_THUMBPRINT` | The certificate's SHA-1 thumbprint. Uses `signtool` from the Windows SDK (or `SIGNTOOL`). |
| Any other signing tool (Azure Trusted Signing, jsign, a provider's own tool) | `WIN_SIGN_COMMAND` | A command that signs one file, with `{file}` where the file goes. |

Also set:
- `WIN_PUBLISHER_NAME`: the certificate's subject name, exactly. From then on, an installed till takes
  an update only if it is signed with that name.
- `WIN_SIGN_TIMESTAMP_URL` if your provider names one (default `http://timestamp.digicert.com`).

Each of the app, its uninstaller and the installer is signed (`scripts/sign-win.cjs`). Check the
result with `signtool verify /pa release\Floreo-Till-Setup-<version>.exe`.

### macOS

A Developer ID certificate in the keychain (or `CSC_LINK`) signs; `APPLE_API_KEY`,
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (an App Store Connect API key) notarize. A Mac takes
updates only when both are done.

### Releasing and updates

Installed tills update themselves from the server they are paired with, so staging's tills follow
staging and production's follow production:

1. Raise `version` in `package.json` (`npm version patch`, for one).
2. `npm run dist:win` (signed, as above).
3. Copy the release into the server's `TILL_DOWNLOADS_DIR`:
   `npm run publish-local -- <folder>` on the same machine, or copy the installer, its `.blockmap` and
   then `latest.yml` (last) with rsync or the hosting's tools.

What a till does (`updates.cjs`, `web/src/pos/updates.ts`):
- It asks the server (`GET /v1/pos/downloads`) when it starts and every four hours.
- A newer version downloads in the background while it keeps selling; only the parts that changed,
  thanks to the `.blockmap`. Its SHA-512 is checked against `latest.yml`.
- The status bar then shows **Restart to update** (Devices says so too). Choosing it closes the till,
  installs silently and opens the new version in a few seconds. If nobody chooses it, the update is
  installed the next time the app is closed. Never in the middle of a sale; sales already made stay
  in the app's data folder, which updates do not touch.
- Settings → Tills in the web app links to the installers, for setting up a new till.

Desktop apps from before updates (1.0.0) do not look for them: install the first version that has
them by hand, once.

## Test

`npm run smoke` starts the app with Playwright and checks:
- the till page;
- the encrypted storage;
- printing to a fake network printer on this computer;
- that raw printing to internet addresses is refused.

With `SMOKE_SERVER`, `SMOKE_CODE` and `SMOKE_PIN` it also does the following against a real server:
- pairs with it;
- signs in;
- sets up a network printer and prints a test page.

`node scripts/offline-check.mjs` (after `npm run e2e` at the root, for its business) checks selling
offline with a real outage: it starts the server, pairs a new till, sells, stops the server, sells
more, quits and restarts the app without the server, signs in offline and sells again, then starts the
server and checks that it has every sale exactly once. It also checks that the local database holds no
business data in plain text and that the data key and the till's token are encrypted by the OS.

The till keeps its sales in the app's own data folder (IndexedDB), which updates and uninstalling keep
(`deleteAppDataOnUninstall: false`).
