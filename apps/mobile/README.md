# eInvoicing Till for iPhone, iPad and Android

The till as a mobile app (Capacitor 8). The till itself is the web till (`web/src/pos`), copied into `www/` as `index.html`.

The native side adds:
- **`TillHardware`**, the app's own plugin. It sends raw ESC/POS bytes to receipt printers:
  - network printers on the local network: Android (`android/.../TillHardwarePlugin.java`) and iOS (`ios/App/App/TillHardwarePlugin.swift`);
  - paired Bluetooth printers: Android only.
- **The camera barcode scanner:** `@capacitor-mlkit/barcode-scanning`.
- **Storage:** `@capacitor/preferences`.
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

For Google Play, build a signed release bundle in Android Studio (Build → Generate Signed App Bundle) with your upload key.

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
