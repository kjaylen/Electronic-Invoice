/**
 * Two-step sign-in screens, shared by the business app and the platform
 * console: entering a code at sign-in, setting up an authenticator app, and
 * showing recovery codes once.
 */

import { type FormEvent, useState } from 'react';
import { useT } from './i18n';
import { useToast } from './toast';
import { ErrorText, Field } from './ui';

export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challenge: string;
  /** Platform staff on their first sign-in: set up the app now. */
  setup?: boolean;
  secret?: string;
  otpauthUrl?: string;
  qr?: string;
}

export interface TwoFactorSetupInfo {
  secret: string;
  otpauthUrl: string;
  qr: string;
}

export const isChallenge = (r: unknown): r is TwoFactorChallenge => Boolean(r && typeof r === 'object' && (r as { twoFactorRequired?: unknown }).twoFactorRequired === true);

/** The secret in groups of four, easier to type into an app by hand. */
const grouped = (secret: string) => secret.replace(/(.{4})(?=.)/g, '$1 ');

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** The 6-digit code from the app, or (switchable) a recovery code. */
export function CodeForm({ onSubmit, onBack, submitLabel }: { onSubmit: (code: string) => Promise<void>; onBack?: () => void; submitLabel?: string }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const { busy, error, run } = useBusy();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => onSubmit(code.trim()));
  };
  return (
    <form className="stack" onSubmit={submit}>
      {recovery ? (
        <Field label={t('Recovery code')} hint={t('One of the codes you saved when you set up two-step sign-in. Each works once.')}>
          <input key="recovery" required autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="xxxxx-xxxxx" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      ) : (
        <Field label={t('Code from your authenticator app')}>
          <input
            key="totp" className="code-input" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} placeholder="123456"
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </Field>
      )}
      <ErrorText error={error} />
      <button type="submit" className="big" disabled={busy || (!recovery && code.length !== 6)}>{busy ? t('Checking…') : submitLabel ?? t('Continue')}<span className="chip" aria-hidden="true">→</span></button>
      <div className="row small">
        <button type="button" className="link" onClick={() => { setRecovery(!recovery); setCode(''); }}>{recovery ? t('Use the code from my app') : t('Lost your phone? Use a recovery code')}</button>
        <span className="spacer" />
        {onBack && <button type="button" className="link" onClick={onBack}>{t('Back')}</button>}
      </div>
    </form>
  );
}

/** Scan the QR code (or type the key), then confirm with the first code. */
export function SetupSteps({ info, onConfirm }: { info: TwoFactorSetupInfo; onConfirm: (code: string) => Promise<void> }) {
  const t = useT();
  const toast = useToast();
  const [code, setCode] = useState('');
  const { busy, error, run } = useBusy();
  return (
    <div className="stack twofactor-setup">
      <ol className="steps-list">
        <li>{t('Install an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password.')}</li>
        <li>{t('In the app, add an account and scan this code.')}</li>
      </ol>
      <div className="qr-box">
        <img src={info.qr} alt={t('QR code for your authenticator app')} width={184} height={184} />
        <div className="stack">
          <span className="small muted">{t('Cannot scan? Enter this key instead:')}</span>
          <code className="secret-key">{grouped(info.secret)}</code>
          <button type="button" className="link small" onClick={() => void navigator.clipboard?.writeText(info.secret).then(() => toast(t('Key copied')))}>{t('Copy the key')}</button>
        </div>
      </div>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(() => onConfirm(code)); }}>
        <Field label={t('3. Enter the 6-digit code the app shows')}>
          <input className="code-input" required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" disabled={busy || code.length !== 6}>{busy ? t('Checking…') : t('Turn on two-step sign-in')}</button>
      </form>
    </div>
  );
}

/** Recovery codes, shown once: copy, download or print them. */
export function RecoveryCodes({ codes, onDone, label }: { codes: string[]; onDone: () => void; label?: string }) {
  const t = useT();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const text = `${label ?? t('Recovery codes')}\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };
  return (
    <div className="stack">
      <div className="banner warn"><div><strong>{t('Save these recovery codes now')}</strong>{t('If you lose your phone, each code lets you sign in once. They are shown only this time.')}</div></div>
      <ul className="recovery-codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <div className="row">
        <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(text).then(() => { toast(t('Codes copied')); setSaved(true); })}>{t('Copy')}</button>
        <button type="button" className="secondary" onClick={download}>{t('Download')}</button>
        <span className="spacer" />
        <button type="button" onClick={onDone} disabled={!saved}>{t('I saved them')}</button>
      </div>
      {!saved && <p className="small muted right">{t('Copy or download them to continue.')}</p>}
    </div>
  );
}
