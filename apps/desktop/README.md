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

Set `VITE_TILL_SERVER=https://app.example.bz` when building the web app to pre-fill the server address in the pairing screen.

## Installers

```bash
npm run dist:win             # Windows installer (NSIS), in release/
npm run dist:mac             # macOS .dmg (build on a Mac; sign and notarize with your Apple Developer ID)
npm run dist:linux           # AppImage and .deb
```

For installers people download, sign them:
- **Windows:** a code-signing certificate, through electron-builder's `win.certificateFile` or `CSC_LINK`.
- **macOS:** a Developer ID, with notarization.

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
