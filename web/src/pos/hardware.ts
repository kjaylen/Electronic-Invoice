/**
 * A till's hardware: receipt printers (with the cash drawer plugged into
 * one), barcode scanners, the customer display. Kept on the till itself;
 * a summary goes to the server so the web app can show what each till has.
 */

import { useEffect, useRef } from 'react';
import type { Platform, PrinterConnection } from './platform';
import { drawerKick, type PrintOptions, type Ticket, toEscPos, toHtml } from './ticket';

export interface PrinterConfig extends PrintOptions {
  id: string;
  name: string;
  connection: PrinterConnection;
  /** Network printers: address and port (9100 for almost every receipt printer). */
  host?: string;
  port?: number;
  /** Bluetooth printers (Android): the paired printer's address. */
  address?: string;
  /** Installed printers (desktop): the name the computer gives it. */
  systemName?: string;
  /** A cash drawer is plugged into this printer. */
  drawer: boolean;
}

export interface HardwareConfig {
  printers: PrinterConfig[];
  /** The printer receipts go to. */
  receiptPrinter: string | null;
  autoPrint: boolean;
  copies: 1 | 2;
  /** Print the end-of-day report when a shift closes. */
  printZReport: boolean;
  /** Open the drawer for cash sales and refunds. */
  openDrawerOnCash: boolean;
  /** USB and Bluetooth scanners that type like a keyboard. */
  scanner: { keyboard: boolean; minLength: number };
  customerDisplay: boolean;
  /** Lock the till after this many minutes without use (0: never). */
  lockAfterMinutes: number;
  /** Printed at the bottom of every receipt (thanks, returns policy). */
  receiptMessage: string;
}

export const DEFAULT_HARDWARE: HardwareConfig = {
  printers: [],
  receiptPrinter: null,
  autoPrint: true,
  copies: 1,
  printZReport: true,
  openDrawerOnCash: true,
  scanner: { keyboard: true, minLength: 4 },
  customerDisplay: false,
  lockAfterMinutes: 10,
  receiptMessage: '',
};

export const newPrinter = (connection: PrinterConnection): PrinterConfig => ({
  id: crypto.randomUUID(),
  name: '',
  connection,
  ...(connection === 'network' && { port: 9100 }),
  paperWidth: 80,
  codepage: 'ascii',
  qr: 'native',
  cut: true,
  drawer: false,
});

const KEY = 'till.hardware';

export async function loadHardware(p: Platform): Promise<HardwareConfig> {
  try {
    const saved = JSON.parse((await p.getItem(KEY)) ?? 'null') as Partial<HardwareConfig> | null;
    return { ...DEFAULT_HARDWARE, ...saved, scanner: { ...DEFAULT_HARDWARE.scanner, ...saved?.scanner } };
  } catch {
    return DEFAULT_HARDWARE;
  }
}

export const saveHardware = (p: Platform, config: HardwareConfig) => p.setItem(KEY, JSON.stringify(config));

/** How a printer is reached, in words. */
export function printerWhere(printer: PrinterConfig): string {
  switch (printer.connection) {
    case 'network': return `${printer.host ?? '?'}:${printer.port ?? 9100}`;
    case 'bluetooth': return printer.address ?? '';
    case 'system': return printer.systemName ?? '';
    case 'browser': return '';
  }
}

/** What the server keeps about the till's hardware (shown in the web app). */
export function hardwareReport(config: HardwareConfig, p: Platform) {
  return {
    device: p.kind,
    printers: config.printers.map((x) => ({ name: x.name, connection: x.connection, where: printerWhere(x), paperWidth: x.paperWidth, drawer: x.drawer, receipts: x.id === config.receiptPrinter })),
    scanner: { keyboard: config.scanner.keyboard, camera: Boolean(p.scanBarcode) },
    customerDisplay: config.customerDisplay && Boolean(p.customerDisplay),
  };
}

/** Print through the browser's dialog (the till in a browser), from a hidden frame. */
function printInBrowser(html: string): Promise<void> {
  return new Promise((resolve) => {
    document.querySelectorAll('iframe.print-frame').forEach((f) => f.remove());
    const frame = document.createElement('iframe');
    frame.className = 'print-frame';
    frame.title = 'Print';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    frame.onload = () => setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      resolve();
    }, 150);
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

export class HardwareError extends Error {
  override name = 'HardwareError';
}

/** Print a ticket on a printer (optionally kicking its drawer when done). */
export async function printTicket(p: Platform, printer: PrinterConfig, ticket: Ticket, options: { openDrawer?: boolean; title?: string } = {}): Promise<void> {
  const openDrawer = Boolean(options.openDrawer && printer.drawer);
  switch (printer.connection) {
    case 'network':
      if (!printer.host) throw new HardwareError(`Set the address of ${printer.name}`);
      if (!p.sendRaw) throw new HardwareError('This device cannot reach network printers');
      return p.sendRaw({ connection: 'network', host: printer.host, port: printer.port ?? 9100 }, toEscPos(ticket, { ...printer, openDrawer }));
    case 'bluetooth':
      if (!printer.address) throw new HardwareError(`Choose the Bluetooth printer for ${printer.name}`);
      if (!p.sendRaw) throw new HardwareError('This device cannot reach Bluetooth printers');
      return p.sendRaw({ connection: 'bluetooth', address: printer.address }, toEscPos(ticket, { ...printer, openDrawer }));
    case 'system':
      if (!p.printHtml) throw new HardwareError('Installed printers work with the desktop app');
      return p.printHtml(toHtml(ticket, printer, options.title), { ...(printer.systemName && { printer: printer.systemName }), widthMm: printer.paperWidth });
    case 'browser':
      return printInBrowser(toHtml(ticket, printer, options.title));
  }
}

/** Open the cash drawer plugged into a printer. */
export async function openDrawer(p: Platform, printer: PrinterConfig): Promise<void> {
  if (!printer.drawer) throw new HardwareError(`No cash drawer is set on ${printer.name}`);
  if (printer.connection === 'network' && printer.host && p.sendRaw) return p.sendRaw({ connection: 'network', host: printer.host, port: printer.port ?? 9100 }, drawerKick());
  if (printer.connection === 'bluetooth' && printer.address && p.sendRaw) return p.sendRaw({ connection: 'bluetooth', address: printer.address }, drawerKick());
  throw new HardwareError('This printer opens the drawer from its own driver settings (set "open drawer after printing" there)');
}

/**
 * Barcode scanners that type like a keyboard: a burst of keys faster than
 * anyone types, ending in Enter (or a pause). Only when no text box has the
 * focus: the counter's search box handles scans typed into it itself.
 */
export function useKeyboardScanner(enabled: boolean, minLength: number, onScan: (code: string) => void) {
  const handler = useRef(onScan);
  handler.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    let buffer = '';
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (buffer.length >= minLength) handler.current(buffer);
      buffer = '';
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        buffer = '';
        return;
      }
      const now = performance.now();
      if (now - last > 60) buffer = '';
      last = now;
      clearTimeout(timer);
      if (e.key === 'Enter') {
        if (buffer.length >= minLength) e.preventDefault();
        flush();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        buffer += e.key;
        // Scanners set to send no Enter: a pause ends the code.
        timer = setTimeout(() => {
          if (performance.now() - last >= 100 && buffer.length >= Math.max(minLength, 6)) flush();
        }, 120);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(timer);
    };
  }, [enabled, minLength]);
}
