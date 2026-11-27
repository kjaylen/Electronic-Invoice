/**
 * The till's devices (managers): receipt printers and the cash drawer,
 * barcode scanners, the customer display, locking, unpairing.
 */

import { type FormEvent, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { Field, Modal, Select } from '../ui';
import { type HardwareConfig, newPrinter, openDrawer, type PrinterConfig, printerWhere, printTicket, useKeyboardScanner } from './hardware';
import type { BluetoothPrinter, PrinterConnection, SystemPrinter } from './platform';
import { testTicket } from './ticket';
import { Button, Chip, Toggle } from './design/components';
import { feedbackSettings } from './design/feedback';
import { useTheme } from './design/theme';
import { useTill } from './TillApp';

const CONNECTION_NAMES: Record<PrinterConnection, string> = {
  network: 'Network (Wi-Fi or Ethernet)',
  bluetooth: 'Bluetooth',
  system: 'Installed on this computer (USB)',
  browser: 'The browser’s print dialog',
};

export function HardwareSettings({ onError }: { onError: (e: unknown) => void }) {
  const t = useT();
  const toast = useToast();
  const till = useTill();
  const hw = till.hardware;
  const [editing, setEditing] = useState<PrinterConfig | null>(null);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const save = (patch: Partial<HardwareConfig>) => void till.setHardware({ ...hw, ...patch }).catch(onError);
  const connections: PrinterConnection[] = till.platform.connections;
  useKeyboardScanner(hw.scanner.keyboard, hw.scanner.minLength, setLastScan);

  const test = async (printer: PrinterConfig) => {
    try {
      await printTicket(till.platform, printer, testTicket({ printer: printer.name, till: till.till.device.name, business: till.till.business.name, options: printer }), { title: 'Test page' });
      toast(t('Test page sent to {name}', { name: printer.name }));
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="stack till-settings">
      <div><span className="kicker">{till.till.device.name}</span><h1>{t('Devices')}</h1></div>

      <Appearance />

      <section className="card stack">
        <div className="row"><h2>{t('Receipt printers')}</h2><span className="spacer" />
          {connections.map((c) => <Button key={c} icon="plus" onClick={() => setEditing({ ...newPrinter(c), name: c === 'browser' ? t('This browser') : '' })}>{t(CONNECTION_NAMES[c])}</Button>)}
        </div>
        {hw.printers.length === 0 && <p className="muted">{t('No printer yet. Most receipt printers connect over the network (port 9100), by Bluetooth (Android) or by USB (computers).')}</p>}
        <ul className="device-list">
          {hw.printers.map((p) => (
            <li key={p.id}>
              <label className="row receipt-choice">
                <input type="radio" name="receipt-printer" checked={(hw.receiptPrinter ?? hw.printers[0]?.id) === p.id} onChange={() => save({ receiptPrinter: p.id })} aria-label={t('Print receipts on {name}', { name: p.name })} />
                <span><strong>{p.name}</strong><span className="muted small"> · {t(CONNECTION_NAMES[p.connection])}{printerWhere(p) && ` · ${printerWhere(p)}`} · {p.paperWidth} mm{p.drawer ? ` · ${t('cash drawer')}` : ''}</span></span>
              </label>
              <span className="spacer" />
              <Button icon="printer" onClick={() => void test(p)}>{t('Test')}</Button>
              {p.drawer && <Button icon="drawer" onClick={() => void openDrawer(till.platform, p).then(() => toast(t('Drawer opened'))).catch(onError)}>{t('Open drawer')}</Button>}
              <Button onClick={() => setEditing(p)}>{t('Edit')}</Button>
              <button type="button" className="link" onClick={() => save({ printers: hw.printers.filter((x) => x.id !== p.id), receiptPrinter: hw.receiptPrinter === p.id ? null : hw.receiptPrinter })}>{t('Remove')}</button>
            </li>
          ))}
        </ul>
        <div className="toggle-list">
          <Toggle checked={hw.autoPrint} onChange={(v) => save({ autoPrint: v })} label={t('Print each receipt automatically')} />
          <Toggle checked={hw.copies === 2} onChange={(v) => save({ copies: v ? 2 : 1 })} label={t('Print two copies')} />
          <Toggle checked={hw.openDrawerOnCash} onChange={(v) => save({ openDrawerOnCash: v })} label={t('Open the cash drawer for cash sales and refunds')} />
          <Toggle checked={hw.printZReport} onChange={(v) => save({ printZReport: v })} label={t('Print the end-of-day report when a shift closes')} />
        </div>
        <Field label={t('Message at the bottom of receipts')} hint={t('Optional: thanks, opening hours, your returns policy.')}>
          <textarea rows={2} maxLength={200} value={hw.receiptMessage} onChange={(e) => save({ receiptMessage: e.target.value })} />
        </Field>
      </section>

      <section className="card stack">
        <h2>{t('Barcode scanners')}</h2>
        <Toggle checked={hw.scanner.keyboard} onChange={(v) => save({ scanner: { ...hw.scanner, keyboard: v } })} label={t('USB and Bluetooth scanners (they type like a keyboard)')} />
        <p className="small muted">{t('Plug the scanner in or pair it with this device, then scan anything here to test it. Set it to send Enter after each code.')}</p>
        <div className="scan-test" role="status">{lastScan ? <>{t('Read')}: <strong className="mono">{lastScan}</strong></> : <span className="muted">{t('Waiting for a scan…')}</span>}</div>
        {till.scanWithCamera
          ? <p className="small">{t('The camera can also scan: use "Scan with the camera" at the counter.')} <button type="button" className="link" onClick={() => void till.scanWithCamera!().then((c) => c && setLastScan(c))}>{t('Try it')}</button></p>
          : <p className="small muted">{t('This device has no camera scanning; use a USB or Bluetooth scanner.')}</p>}
      </section>

      {till.platform.customerDisplay && (
        <section className="card stack">
          <h2>{t('Customer display')}</h2>
          <Toggle checked={hw.customerDisplay} onChange={(v) => save({ customerDisplay: v })} label={t('Show the sale and the total on a second screen facing the customer')} />
          <p className="small muted">{t('Connect a second monitor or pole display set up as a screen; the till opens full screen on it.')}</p>
        </section>
      )}

      <section className="card stack">
        <h2>{t('This till')}</h2>
        <dl className="facts">
          <div><dt>{t('Name')}</dt><dd>{till.till.device.name}</dd></div>
          <div><dt>{t('Cash drawer')}</dt><dd>{till.till.device.register.name}</dd></div>
          <div><dt>{t('Server')}</dt><dd className="mono small">{till.server}</dd></div>
          <div><dt>{t('App')}</dt><dd>{till.platform.kind} {till.platform.appVersion}</dd></div>
          {till.update.kind !== 'none' && (
            <div><dt>{t('Update')}</dt><dd>
              {till.update.kind === 'downloading'
                ? t('Version {v} is downloading ({p}%)', { v: till.update.version, p: till.update.percent ?? 0 })
                : <>{t('Version {v} is ready', { v: till.update.version })} <button type="button" className="link" onClick={till.offerUpdate}>{till.update.kind === 'ready' ? t('Restart to update') : t('Download')}</button></>}
            </dd></div>
          )}
        </dl>
        <Field label={t('Lock the till after')}>
          <Select value={hw.lockAfterMinutes} onChange={(e) => save({ lockAfterMinutes: Number(e.target.value) })}>
            {[2, 5, 10, 30, 60].map((m) => <option key={m} value={m}>{t('{n} minutes without use', { n: m })}</option>)}
            <option value={0}>{t('Never')}</option>
          </Select>
        </Field>
        <p className="small muted">{t('Rename the till or move it to another cash drawer in the web app: Settings → Tills.')}</p>
        <div className="row"><Button variant="danger" onClick={() => setConfirmUnpair(true)}>{t('Unpair this till')}</Button></div>
      </section>

      {editing && <PrinterEditor printer={editing} onClose={() => setEditing(null)} onSave={(p) => {
        const exists = hw.printers.some((x) => x.id === p.id);
        save({ printers: exists ? hw.printers.map((x) => (x.id === p.id ? p : x)) : [...hw.printers, p], receiptPrinter: hw.receiptPrinter ?? p.id });
        setEditing(null);
      }} />}
      {confirmUnpair && (
        <Modal title={t('Unpair this till?')} onClose={() => setConfirmUnpair(false)}>
          <div className="stack">
            <p>{t('It signs everyone out and forgets this business. To use it again, a manager makes a new pairing code in the web app.')}</p>
            <div className="row"><button type="button" className="secondary" onClick={() => setConfirmUnpair(false)}>{t('Cancel')}</button><span className="spacer" /><button type="button" className="danger" onClick={() => void till.unpair()}>{t('Unpair')}</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** How this till looks and feels: light or dark, a vibration on key taps, a soft click. Kept on this device. */
function Appearance() {
  const t = useT();
  const [theme, setTheme] = useTheme();
  const [haptics, setHaptics] = useState(feedbackSettings.haptics);
  const [sound, setSound] = useState(feedbackSettings.sound);
  return (
    <section className="card stack">
      <h2>{t('Appearance')}</h2>
      <div className="setting-line">
        <span className="what"><strong>{t('Theme')}</strong><span>{t('Dark is easier on the eyes in a dim bar or at night.')}</span></span>
        <div className="chip-row" role="group" aria-label={t('Theme')}>
          <Chip icon="sun" pressed={theme === 'light'} onClick={() => setTheme('light')}>{t('Light')}</Chip>
          <Chip icon="moon" pressed={theme === 'dark'} onClick={() => setTheme('dark')}>{t('Dark')}</Chip>
          <Chip icon="devices" pressed={theme === 'system'} onClick={() => setTheme('system')}>{t('Same as the device')}</Chip>
        </div>
      </div>
      <div className="toggle-list">
        <Toggle checked={haptics} onChange={(v) => { feedbackSettings.set('haptics', v); setHaptics(v); }} label={t('Vibrate on key taps (where the device can)')} />
        <Toggle checked={sound} onChange={(v) => { feedbackSettings.set('sound', v); setSound(v); }} label={t('A soft click on key taps')} />
      </div>
    </section>
  );
}

function PrinterEditor({ printer, onClose, onSave }: { printer: PrinterConfig; onClose: () => void; onSave: (p: PrinterConfig) => void }) {
  const t = useT();
  const till = useTill();
  const [p, setP] = useState(printer);
  const [system, setSystem] = useState<SystemPrinter[] | null>(null);
  const [bluetooth, setBluetooth] = useState<BluetoothPrinter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<PrinterConfig>) => setP((x) => ({ ...x, ...patch }));
  useEffect(() => {
    if (p.connection === 'system' && till.platform.listSystemPrinters) void till.platform.listSystemPrinters().then(setSystem).catch((e) => setError(String(e)));
    if (p.connection === 'bluetooth' && till.platform.listBluetoothPrinters) void till.platform.listBluetoothPrinters().then(setBluetooth).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [p.connection, till.platform]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ ...p, name: p.name.trim() || t('Receipt printer') });
  };
  const raw = p.connection === 'network' || p.connection === 'bluetooth';
  return (
    <Modal title={printer.name ? t('Edit {name}', { name: printer.name }) : t('Add a printer')} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <p className="small muted">{t(CONNECTION_NAMES[p.connection])}</p>
        <Field label={t('Name')}><input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('e.g. Front counter printer')} maxLength={40} autoFocus /></Field>
        {p.connection === 'network' && (
          <div className="form-grid">
            <Field label={t('IP address')} hint={t('On the printer’s self-test page (hold the feed button while turning it on).')}><input inputMode="decimal" value={p.host ?? ''} onChange={(e) => set({ host: e.target.value.trim() })} placeholder="192.168.1.50" required /></Field>
            <Field label={t('Port')}><input inputMode="numeric" value={String(p.port ?? 9100)} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, '')) || 9100 })} /></Field>
          </div>
        )}
        {p.connection === 'bluetooth' && (
          <Field label={t('Bluetooth printer')} hint={t('Pair the printer in the device’s Bluetooth settings first (the PIN is often 0000 or 1234).')}>
            <Select value={p.address ?? ''} onChange={(e) => set({ address: e.target.value, name: p.name || bluetooth?.find((b) => b.address === e.target.value)?.name || '' })} required>
              <option value="">{bluetooth ? t('Choose…') : t('Looking for paired printers…')}</option>
              {bluetooth?.map((b) => <option key={b.address} value={b.address}>{b.name} ({b.address})</option>)}
            </Select>
          </Field>
        )}
        {p.connection === 'system' && (
          <Field label={t('Printer')} hint={t('Install the printer’s driver on this computer first. Set its paper size to the roll width.')}>
            <Select value={p.systemName ?? ''} onChange={(e) => set({ systemName: e.target.value, name: p.name || e.target.value })}>
              <option value="">{t('The default printer')}</option>
              {system?.map((s) => <option key={s.name} value={s.name}>{s.name}{s.isDefault ? ` (${t('default')})` : ''}</option>)}
            </Select>
          </Field>
        )}
        <div className="form-grid">
          <Field label={t('Paper width')}>
            <Select value={p.paperWidth} onChange={(e) => set({ paperWidth: Number(e.target.value) as 58 | 80 })}>
              <option value={80}>80 mm</option>
              <option value={58}>58 mm</option>
            </Select>
          </Field>
          {raw && (
            <Field label={t('Accented letters')} hint={t('Print a test page: if á or ñ come out wrong, try another setting.')}>
              <Select value={p.codepage} onChange={(e) => set({ codepage: e.target.value as PrinterConfig['codepage'] })}>
                <option value="ascii">{t('Plain letters (works on every printer)')}</option>
                <option value="cp850">{t('Code page 850')}</option>
                <option value="cp1252">{t('Windows-1252')}</option>
              </Select>
            </Field>
          )}
          {raw && (
            <Field label={t('QR code')}>
              <Select value={p.qr} onChange={(e) => set({ qr: e.target.value as PrinterConfig['qr'] })}>
                <option value="native">{t('Drawn by the printer')}</option>
                <option value="image">{t('Sent as a picture (older printers)')}</option>
              </Select>
            </Field>
          )}
        </div>
        {raw && <label className="row"><input type="checkbox" checked={p.cut} onChange={(e) => set({ cut: e.target.checked })} /> {t('Cut the paper after each receipt')}</label>}
        <label className="row"><input type="checkbox" checked={p.drawer} onChange={(e) => set({ drawer: e.target.checked })} disabled={!raw} /> {t('A cash drawer is plugged into this printer')}</label>
        {!raw && <p className="small muted">{t('For a drawer on an installed printer, turn on "open cash drawer" in the printer driver’s settings.')}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button>{t('Save')}</button></div>
      </form>
    </Modal>
  );
}
