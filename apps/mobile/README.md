# Floreo Till for iPhone, iPad and Android

The till as a mobile app (Capacitor 8). The till itself is the web till (`web/src/pos`), copied into `www/` as `index.html`.

The native side adds:
- **`TillHardware`**, the app's own plugin. It sends raw ESC/POS bytes to receipt printers:
  - network printers on the local network: Android (`android/.../TillHardwarePlugin.java`) and iOS (`ios/App/App/TillHardwarePlugin.swift`);
  - paired Bluetooth printers: Android only.
- **The camera barcode scanner:** `@capacitor-mlkit/barcode-scanning`.
- **Storage:** `@capacitor/preferences` for settings. Secrets (the till's token, the key of its local data) go through `TillHardware`: encrypted with a key in the Android Keystore, or in the iOS Keychain (this device only). The sales and catalog the till keeps offline are in the web view's IndexedDB, encrypted with that key; they survive app updates, not uninstalling.
- **The app version:** `@capacitor/app`.

The screen stays on while the till is open.

## Build

```bash
npm run web:build            # at the repository root: builds web/dist (with the till page)
cd apps/mobile
npm install
npm run sync                 # copies the till into www/ and into both native projects
```

### Android

- `npm run android` opens Android Studio. Alternatively, `npm run apk` builds a debug APK in `android/app/build/outputs/apk/debug/`.
- The project uses Gradle 9.1, which runs on Android Studio's bundled JDK (version 25).
- On Windows, if Gradle fails with "Unable to establish loopback connection", the JDK cannot create its socket in a temp folder whose path has spaces. Point it elsewhere:

```powershell
$env:JAVA_TOOL_OPTIONS = '-Djdk.net.unixdomain.tmpdir=C:\Windows\Temp'
```

### Android releases

The version comes from `version` in `package.json` (1.2.3 becomes versionName 1.2.3, versionCode
10203). Raise it for each release.

**The release key, once.** Make it, and keep the file and its password in the team's password
manager: an app signed with a lost key can never be updated in place again, every till would have to
uninstall (losing anything unsent) and install anew.

```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore floreo-release.jks -alias floreo -keyalg RSA -keysize 4096 -validity 10000
```

Then either `android/keystore.properties` (git-ignored):

```properties
storeFile=C:/keys/floreo-release.jks
storePassword=...
keyAlias=floreo
keyPassword=...
```

or the variables `FLOREO_ANDROID_STORE_FILE`, `FLOREO_ANDROID_STORE_PASSWORD`,
`FLOREO_ANDROID_KEY_ALIAS` and `FLOREO_ANDROID_KEY_PASSWORD` (for a build server).

**Each release:** `npm run release:android` (add `-- --to <folder>` to copy it into a server's
`TILL_DOWNLOADS_DIR` on this machine). In `release/`:
- `Floreo-Till-<version>.aab` for Google Play. With Play App Signing, this key is your upload key.
- `Floreo-Till-<version>.apk` and `android.json`, for tills installed from the server. Copy the APK
  first and `android.json` last.

How tills get it:
- **From Google Play:** Play updates the app. Leave the APK and `android.json` off the server.
- **From the server** (Settings → Tills → Get the till app): the till checks when it starts and every
  four hours. When a newer one is there, the status bar shows **Update available**; it downloads in the
  browser, and Android asks to install it over the old one (same key, so nothing is lost). Android asks
  once to allow installing apps from the browser.

### iOS

On a Mac with Xcode:
1. Run `npm run ios`.
2. Choose your team under Signing & Capabilities.
3. Run on a device or archive for the App Store.

The project uses Swift Package Manager (no CocoaPods).

iOS asks two permissions the first time each is used:
- **Local network:** to reach receipt printers.
- **Camera:** for barcodes and the pairing QR code.

Bluetooth receipt printers are an Android feature: most use classic Bluetooth, which iOS apps cannot reach without the printer maker's MFi licence. On iPhone and iPad, use a network printer.

## Server address

The app pairs with the server named in the pairing QR code, or the one typed on the pairing screen. Set `VITE_TILL_SERVER=https://app.example.bz` when building the web app to pre-fill it.

The server must use HTTPS: Android and iOS block plain HTTP from the app.
