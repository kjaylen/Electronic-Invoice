/**
 * Two things a NetSuite connection can add, each set up from a short guide
 * with everything to download or copy in it:
 *
 *   - the BTS QR code on NetSuite's own printed invoices: a field Floreo
 *     fills with the code's address, and a block to paste into the invoice
 *     template that draws it;
 *   - instant sending: a script NetSuite runs when a sale is saved, so it
 *     reaches BTS in seconds instead of at the next minute's read.
 */

import { type ReactNode, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Modal } from '../ui';

export interface NetSuiteAddonsProps {
  linkId: string;
  numberField: string;
  qrField: string | null;
  /** The script has been downloaded for this connection. */
  instant: boolean;
  onChanged: () => void;
}

const DEFAULT_QR_FIELD = 'custbody_bts_qr';

function saveFile(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The block for NetSuite's Advanced PDF/HTML invoice template: the QR code (30 mm, above the 25 mm
 * the Belize Tax Service asks for) beside the BTS number, the wording BTS prescribes for a test
 * document, and for one not authorized yet. Written for the fields this connection uses.
 */
export function qrTemplateBlock(numberField: string, qrField: string): string {
  const v = (field: string) => '${record.' + field + '}';
  return [
    '<!-- Floreo: the BTS QR code and number. Paste this just above </body>. -->',
    `<#if record.${qrField}?has_content>`,
    '<table style="width: 100%; margin-top: 14px; page-break-inside: avoid;"><tr>',
    `  <td style="width: 92px; padding: 0;"><barcode codetype="qrcode" showtext="false" height="85" width="85" value="${v(qrField)}"/></td>`,
    '  <td style="padding: 0 0 0 10px; vertical-align: middle; font-size: 9pt;">',
    '    <b>Authorized by the Belize Tax Service</b><br />',
    `    BTS No. ${v(numberField)}<br />`,
    '    <span style="font-size: 8pt; color: #555555;">Scan the code to check this document with BTS.</span>',
    `    <#if record.${qrField}?contains("portal.test.")><br /><span style="font-size: 8pt;">Transmitted to tests environment, no fiscal value</span></#if>`,
    '  </td>',
    '</tr></table>',
    '<#else>',
    '<p style="font-size: 9pt; margin-top: 14px;">Pending of BTS authorization</p>',
    '</#if>',
    '',
  ].join('\n');
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="secondary small-button"
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }).catch(() => {})}
    >
      {copied ? t('Copied') : label}
    </button>
  );
}

/** A numbered step of a guide: what to do, and whether it is done. */
function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  const t = useT();
  return (
    <li className={`guide-step ${done ? 'done' : ''}`}>
      <span className="guide-number" aria-hidden="true">{done ? '✓' : n}</span>
      <div className="stack guide-body">
        <strong>{title}{done && <span className="sr-only"> ({t('done')})</span>}</strong>
        {children}
      </div>
    </li>
  );
}

/** What to type into a NetSuite form, field by field. */
function Spec({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="guide-spec">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function NetSuiteAddons(props: NetSuiteAddonsProps) {
  const t = useT();
  const [open, setOpen] = useState<null | 'qr' | 'instant'>(null);
  return (
    <div className="addons">
      <div className="addon">
        <div className="addon-text">
          <strong>{t('BTS QR code on NetSuite invoices')}</strong>
          <span className="small muted">{t('Your own NetSuite printout carries the QR code and BTS number, as the Belize Tax Service asks.')}</span>
        </div>
        <span className={`badge ${props.qrField ? 'authorized' : 'cancelled'}`}>{props.qrField ? t('On') : t('Not set up')}</span>
        <button type="button" className="secondary small-button" onClick={() => setOpen('qr')}>{props.qrField ? t('Open the guide') : t('Set up')}</button>
      </div>
      <div className="addon">
        <div className="addon-text">
          <strong>{t('Instant sending')}</strong>
          <span className="small muted">{props.instant ? t('NetSuite tells Floreo the moment a sale is saved: it reaches BTS in seconds.') : t('Sales are read every minute. With a small script in NetSuite, they are sent within seconds of being saved.')}</span>
        </div>
        <span className={`badge ${props.instant ? 'authorized' : 'cancelled'}`}>{props.instant ? t('Script downloaded') : t('Every minute')}</span>
        <button type="button" className="secondary small-button" onClick={() => setOpen('instant')}>{props.instant ? t('Open the guide') : t('Set up')}</button>
      </div>
      {open === 'qr' && <QrGuide {...props} onClose={() => setOpen(null)} />}
      {open === 'instant' && <InstantGuide {...props} onClose={() => setOpen(null)} />}
    </div>
  );
}

function QrGuide({ linkId, numberField, qrField, onChanged, onClose }: NetSuiteAddonsProps & { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [field, setField] = useState(qrField ?? DEFAULT_QR_FIELD);
  const [saved, setSaved] = useState(qrField);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const block = qrTemplateBlock(numberField, saved ?? (field.trim().toLowerCase() || DEFAULT_QR_FIELD));
  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/connectors/${linkId}`, { method: 'PUT', body: { netsuite: { qrField: value } } });
      setSaved(value || null);
      onChanged();
      toast(value ? t('Floreo now fills {field} with each document’s QR address', { field: value }) : t('The QR address is no longer written to NetSuite'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('BTS QR code on NetSuite invoices')} onClose={onClose} wide>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{t('Three steps, about five minutes. Floreo puts the code’s address in a field on each sale; a block in your invoice template draws it.')}</p>
        <ol className="guide">
          <Step n={1} title={t('In NetSuite, create the field')}>
            <span className="small muted">{t('Customization > Lists, Records & Fields > Transaction Body Fields > New')}</span>
            <Spec rows={[[t('Label'), 'BTS QR'], ['ID', `_${(field.trim().toLowerCase() || DEFAULT_QR_FIELD).replace(/^custbody_?/, '')}`], [t('Type'), 'Free-Form Text'], [t('Applies to'), 'Sale'], [t('Store value'), t('Ticked')]]} />
          </Step>
          <Step n={2} title={t('Tell Floreo to fill it')} done={Boolean(saved)}>
            <div className="row guide-row">
              <input className="mono" aria-label={t('QR code field')} value={field} spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setField(e.target.value)} />
              <button type="button" disabled={busy || !field.trim() || field.trim().toLowerCase() === saved} onClick={() => void save(field.trim().toLowerCase())}>{busy ? t('Checking…') : saved ? t('Change') : t('Turn on')}</button>
              {saved && <button type="button" className="link small" disabled={busy} onClick={() => void save('')}>{t('Turn off')}</button>}
            </div>
            <ErrorText error={error} />
            <span className="small muted">{saved ? t('On: every authorized sale gets its QR address in {field}, about a minute after it is saved.', { field: saved }) : t('Floreo checks the connection when you turn it on.')}</span>
          </Step>
          <Step n={3} title={t('Add the block to your invoice template')}>
            <span className="small muted">{t('Customization > Forms > Advanced PDF/HTML Templates > your invoice template > Edit > Source Code. Paste the block just above </body>, then Save. Do the same for cash sales and credit memos if you print them.')}</span>
            <pre className="guide-code" tabIndex={0}>{block}</pre>
            <div className="row guide-row">
              <button type="button" onClick={() => saveFile('floreo-bts-qr-block.xml', block, 'text/xml')}>{t('Download the block')}</button>
              <CopyButton text={block} label={t('Copy the block')} />
            </div>
            <span className="small muted">{t('It prints the code at 30 mm (BTS asks for at least 25), the BTS number beside it, and “Pending of BTS authorization” on a sale BTS has not answered yet.')}</span>
          </Step>
        </ol>
        <div className="banner info" role="note"><div><strong>{t('To check it')}</strong>{t('Save an invoice in NetSuite, wait a minute (seconds with instant sending), then print it: the code is at the bottom. Scan it with a phone to see the address it holds.')}</div></div>
        <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Done')}</button></div>
      </div>
    </Modal>
  );
}

function InstantGuide({ linkId, instant, onChanged, onClose }: NetSuiteAddonsProps & { onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The script carries this connection's own token, made when it is downloaded: a new one replaces the last.
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ filename: string; script: string }>(`/v1/connectors/${linkId}/notify-script`, { method: 'POST', body: {} });
      saveFile(r.filename, r.script, 'text/javascript');
      setDownloaded(true);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Instant sending')} onClose={onClose} wide>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{t('Without it, Floreo reads NetSuite every minute. With it, NetSuite says so the moment a sale is saved, and the sale reaches BTS within seconds. The script sends nothing about the sale, and saving in NetSuite still works if Floreo cannot be reached.')}</p>
        <ol className="guide">
          <Step n={1} title={t('Download the script')} done={downloaded}>
            <div className="row guide-row">
              <button type="button" disabled={busy} onClick={() => void download()}>{busy ? t('Making it…') : instant || downloaded ? t('Download a new script') : t('Download the script')}</button>
              <span className="small mono muted">floreo_notify.js</span>
            </div>
            <ErrorText error={error} />
            {(instant || downloaded) && <span className="small muted">{t('Each download makes a new script for this connection: one downloaded earlier stops working, so install the newest.')}</span>}
          </Step>
          <Step n={2} title={t('In NetSuite, upload it')}>
            <span className="small muted">{t('Customization > Scripting > Scripts > New. Choose the file, then Create Script Record.')}</span>
            <Spec rows={[[t('Name'), 'Floreo notify'], [t('Type'), 'User Event (NetSuite reads this from the file)']]} />
          </Step>
          <Step n={3} title={t('Deploy it on your sales')}>
            <span className="small muted">{t('On the script’s Deployments tab, add three lines, one for each kind of sale, then Save.')}</span>
            <Spec rows={[[t('Applies to'), 'Invoice · Cash Sale · Credit Memo'], [t('Status'), 'Released'], [t('Execute as role'), 'Administrator'], [t('Audience'), t('All roles')]]} />
          </Step>
        </ol>
        <div className="banner info" role="note"><div><strong>{t('To check it')}</strong>{t('Save an invoice in NetSuite. Within a few seconds it shows under “Sent” here, and its BTS number appears on the invoice in NetSuite. If nothing changes, look at the script’s Execution Log in NetSuite; the sale is still picked up at the next minute’s read either way.')}</div></div>
        <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Done')}</button></div>
      </div>
    </Modal>
  );
}
