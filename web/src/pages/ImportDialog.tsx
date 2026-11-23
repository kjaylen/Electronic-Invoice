/**
 * Import a spreadsheet (CSV) of items or customers: download a template, choose the file, see
 * what each row will do (a dry run on the server), then import the good rows.
 */

import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Modal } from '../ui';

interface RowResult { row: number; action: 'create' | 'update' | 'error'; name: string; detail?: string; message?: string }
interface ImportResult { dryRun: boolean; rows: number; created: number; updated: number; errors: number; results: RowResult[] }

const TEMPLATES = {
  items: 'Name,Code,Barcode,Price,GST,Unit,Stock,Low stock,Quick button\r\nCoffee beans 1lb,CB1,7500000000028,22.00,S,each,24,6,yes\r\nRice 5 lb,RICE5,,11.00,Z,each,,,\r\n',
  customers: 'Name,TIN,Email,Phone,Street,City,District\r\nIsland Logistics Ltd.,777888,accounts@islandlogistics.example,223-4567,4 Mile Northern Highway,Belize City,Belize\r\n',
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ImportDialog({ kind, onClose, onDone }: { kind: 'items' | 'customers'; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const url = kind === 'items' ? '/v1/items/import' : '/v1/customers/import';

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setCheck(null);
    if (f.size > 4_000_000) return setError(new Error(t('The file is larger than 4 MB. Split it into smaller files.')));
    const csv = await f.text();
    setFile({ name: f.name, csv });
    setBusy(true);
    try {
      setCheck(await api<ImportResult>(url, { method: 'POST', body: { csv, dryRun: true } }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<ImportResult>(url, { method: 'POST', body: { csv: file.csv } });
      toast(t('{created} added, {updated} updated.', { created: r.created, updated: r.updated }));
      onDone();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const ready = check ? check.created + check.updated : 0;

  return (
    <Modal wide title={kind === 'items' ? t('Import items') : t('Import customers')} onClose={onClose}>
      <p className="muted small">
        {kind === 'items'
          ? t('A spreadsheet saved as CSV, one item per row: Name and Price (before GST, or a "Price with GST" column) are needed; Code, Barcode, GST (S, Z or E), Unit, Stock, Low stock and Quick button are optional. Items with the same code or barcode are updated.')
          : t('A spreadsheet saved as CSV, one customer per row: Name is needed; TIN, Email, Phone, Street, City and District are optional. Customers with the same TIN or email are updated.')}
      </p>
      <div className="row import-actions">
        <label className="button secondary file-button">
          {file ? t('Choose another file') : t('Choose a CSV file')}
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <button type="button" className="link" onClick={() => download(`${kind}-template.csv`, TEMPLATES[kind])}>{t('Download a template')}</button>
        {file && <span className="small muted">{file.name}</span>}
      </div>
      <ErrorText error={error} />
      {busy && !check && <div className="skeleton" style={{ height: '6rem' }} />}
      {check && (
        <div className="stack import-check">
          <div className="import-summary">
            <span className="badge authorized">{t('{n} new', { n: check.created })}</span>
            <span className="badge pending">{t('{n} to update', { n: check.updated })}</span>
            {check.errors > 0 && <span className="badge rejected">{t('{n} with problems', { n: check.errors })}</span>}
          </div>
          <div className="table-wrap import-table">
            <table>
              <thead><tr><th scope="col">{t('Row')}</th><th scope="col">{t('Name')}</th><th scope="col">{t('What happens')}</th></tr></thead>
              <tbody>
                {check.results.slice(0, 200).map((r) => (
                  <tr key={r.row} className={r.action === 'error' ? 'import-error' : ''}>
                    <td className="mono">{r.row}</td>
                    <td>{r.name}</td>
                    <td>
                      {r.action === 'error' ? <span className="import-problem">{r.message}</span> : r.action === 'create' ? t('Added') : t('Updated')}
                      {r.detail && <span className="small muted"> · {r.detail}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {check.results.length > 200 && <p className="small muted">{t('Showing the first 200 rows of {n}.', { n: check.results.length })}</p>}
        </div>
      )}
      <div className="row end">
        <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
        <button type="button" disabled={!ready || busy} onClick={() => void run()}>
          {busy && check ? t('Importing…') : check?.errors ? (ready === 1 ? t('Import 1 row, skip the rest') : t('Import {n} rows, skip the rest', { n: ready })) : ready === 1 ? t('Import 1 row') : t('Import {n} rows', { n: ready })}
        </button>
      </div>
    </Modal>
  );
}
