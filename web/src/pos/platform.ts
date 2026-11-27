/**
 * What the till can do on the device it runs on. The same code runs in:
 *
 *   - the desktop app (Electron, Windows/macOS/Linux): window.tillDesktop,
 *     from its preload script. Network receipt printers, installed (USB)
 *     printers without a dialog, a customer display on a second screen.
 *   - the iOS and Android apps (Capacitor): native plugins through
 *     window.Capacitor. Network printers (both), Bluetooth printers
 *     (Android), the camera as a barcode scanner.
 *   - a browser at /pos: the browser's print dialog, the camera where the
 *     browser can read barcodes.
 *
 * USB and Bluetooth barcode scanners type like a keyboard and work everywhere.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import type { DesktopUpdateState } from './updates';

export type PrinterConnection = 'network' | 'bluetooth' | 'system' | 'browser';
export type RawTarget = { connection: 'network'; host: string; port: number } | { connection: 'bluetooth'; address: string };

export interface SystemPrinter { name: string; isDefault?: boolean }
export interface BluetoothPrinter { name: string; address: string }

export interface DisplayState {
  business: string;
  lines: Array<{ name: string; quantity: string; amount: string }>;
  total: string;
  change: string | null;
  message?: string;
  /** The total in US dollars, when the business shows it. */
  usd?: string;
}

export interface Platform {
  kind: 'desktop' | 'ios' | 'android' | 'web';
  appVersion: string;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /** Secrets (the till's token, the key of its local data), in the platform's secure storage. None in a browser. */
  secret?: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
  /** The printer connections this device can use. */
  connections: PrinterConnection[];
  /** Send ESC/POS bytes to a receipt printer. */
  sendRaw?(target: RawTarget, data: Uint8Array): Promise<void>;
  /** Print a page on an installed printer, without a dialog. */
  printHtml?(html: string, options: { printer?: string; widthMm: number }): Promise<void>;
  listSystemPrinters?(): Promise<SystemPrinter[]>;
  listBluetoothPrinters?(): Promise<BluetoothPrinter[]>;
  /** Read a barcode with the camera (null if cancelled). */
  scanBarcode?(): Promise<string | null>;
  /** The screen facing the customer. */
  customerDisplay?: { open(): Promise<boolean>; update(state: DisplayState): void; close(): void };
  /** The desktop app updating itself from the till's server (see updates.ts). */
  updates?: DesktopUpdates;
}

export interface DesktopUpdates {
  check(server: string): Promise<DesktopUpdateState>;
  state(): Promise<DesktopUpdateState>;
  install(): Promise<boolean>;
  onStatus(fn: (state: DesktopUpdateState) => void): () => void;
}

// ---------- the desktop app ----------

interface DesktopBridge {
  version: string;
  os: string;
  store: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
  printers: {
    list(): Promise<SystemPrinter[]>;
    printHtml(html: string, options: { printer?: string; widthMm: number }): Promise<void>;
    sendNetwork(host: string, port: number, data: Uint8Array): Promise<void>;
  };
  display: { open(): Promise<boolean>; update(state: DisplayState): void; close(): void };
  /** Missing in desktop apps from before updates (1.0.0). */
  updates?: DesktopUpdates;
}

// ---------- Capacitor (iOS and Android) ----------

interface PreferencesPlugin {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
}
/** The app's own plugin (apps/mobile): raw bytes to network and Bluetooth printers. */
interface TillHardwarePlugin {
  sendNetwork(o: { host: string; port: number; data: string }): Promise<void>;
  listBluetooth(): Promise<{ devices: BluetoothPrinter[] }>;
  sendBluetooth(o: { address: string; data: string }): Promise<void>;
  /** Secure storage: Android Keystore, iOS Keychain. */
  secretGet(o: { key: string }): Promise<{ value: string | null }>;
  secretSet(o: { key: string; value: string }): Promise<void>;
  secretRemove(o: { key: string }): Promise<void>;
}
interface AppPlugin { getInfo(): Promise<{ version: string }> }
interface BarcodeScannerPlugin {
  scan(o?: { formats?: string[] }): Promise<{ barcodes: Array<{ rawValue: string }> }>;
  requestPermissions(): Promise<{ camera: string }>;
  isGoogleBarcodeScannerModuleAvailable?(): Promise<{ available: boolean }>;
  installGoogleBarcodeScannerModule?(): Promise<void>;
}

declare global {
  interface Window {
    tillDesktop?: DesktopBridge;
  }
}

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const local = {
  getItem: async (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: async (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked */
    }
  },
  removeItem: async (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage blocked */
    }
  },
};

/** The camera in a browser that can read barcodes (Chrome on Android, macOS, ChromeOS). */
export const browserCanScan = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

async function detectPlatform(): Promise<Platform> {
  const desktop = window.tillDesktop;
  if (desktop) {
    return {
      kind: 'desktop',
      appVersion: desktop.version,
      getItem: (k) => desktop.store.get(k),
      setItem: (k, v) => desktop.store.set(k, v),
      removeItem: (k) => desktop.store.remove(k),
      // The desktop store encrypts these keys with the operating system's key (safeStorage).
      secret: desktop.store,
      connections: ['network', 'system'],
      sendRaw: async (target, data) => {
        if (target.connection !== 'network') throw new Error('This computer reaches receipt printers over the network or as installed printers');
        await desktop.printers.sendNetwork(target.host, target.port, data);
      },
      printHtml: (html, options) => desktop.printers.printHtml(html, options),
      listSystemPrinters: () => desktop.printers.list(),
      customerDisplay: desktop.display,
      ...(desktop.updates && { updates: desktop.updates }),
    };
  }
  // The native plugins by name: Preferences and App (Capacitor's), BarcodeScanner (ML Kit), TillHardware (ours).
  if (Capacitor.isNativePlatform()) {
    const kind = Capacitor.getPlatform() === 'ios' ? 'ios' as const : 'android' as const;
    const prefs = registerPlugin<PreferencesPlugin>('Preferences');
    const hardware = registerPlugin<TillHardwarePlugin>('TillHardware');
    const scanner = registerPlugin<BarcodeScannerPlugin>('BarcodeScanner');
    const version = await registerPlugin<AppPlugin>('App').getInfo().then((i) => i.version).catch(() => '');
    return {
      kind,
      appVersion: version,
      getItem: async (key) => (await prefs.get({ key })).value,
      setItem: (key, value) => prefs.set({ key, value }),
      removeItem: (key) => prefs.remove({ key }),
      secret: {
        get: async (key) => (await hardware.secretGet({ key })).value,
        set: (key, value) => hardware.secretSet({ key, value }),
        remove: (key) => hardware.secretRemove({ key }),
      },
      connections: kind === 'android' ? ['network', 'bluetooth'] : ['network'],
      sendRaw: async (target, data) => {
        if (target.connection === 'network') return hardware.sendNetwork({ host: target.host, port: target.port, data: base64(data) });
        if (kind !== 'android') throw new Error('Bluetooth printers work with the Android app');
        return hardware.sendBluetooth({ address: target.address, data: base64(data) });
      },
      ...(kind === 'android' && { listBluetoothPrinters: async () => (await hardware.listBluetooth()).devices }),
      scanBarcode: async () => {
        if (kind === 'android' && scanner.isGoogleBarcodeScannerModuleAvailable) {
          const { available } = await scanner.isGoogleBarcodeScannerModuleAvailable();
          if (!available) await scanner.installGoogleBarcodeScannerModule?.();
        }
        await scanner.requestPermissions().catch(() => {});
        const { barcodes } = await scanner.scan();
        return barcodes[0]?.rawValue ?? null;
      },
    };
  }
  return { kind: 'web', appVersion: 'web', ...local, connections: ['browser'] };
}

let current: Promise<Platform> | null = null;
export const platform = () => (current ??= detectPlatform());
