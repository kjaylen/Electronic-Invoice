/** Paying with a wallet app (E-Kyash): the QR code to scan, and the button that opens the app on a phone. */

import { useT } from './i18n';
import { money } from './ui';

export interface WalletInfo {
  provider: 'ekyash';
  qr: string;
  deepLink: string | null;
}

export function WalletPay({ wallet, amount }: { wallet: WalletInfo; amount: string }) {
  const t = useT();
  return (
    <section className="card stack wallet-pay" aria-live="polite">
      <div className="row">
        <h2>{t('Pay {amount} with E-Kyash', { amount: money(amount) })}</h2>
      </div>
      <div className="wallet-body">
        <img className="wallet-qr" src={wallet.qr} width={220} height={220} alt={t('QR code to pay with the E-Kyash app')} />
        <ol className="wallet-steps small">
          <li>{t('Open the E-Kyash app and scan this code.')}</li>
          <li>{t('Check the amount and accept the payment.')}</li>
          <li>{t('This page updates by itself when it is paid.')}</li>
        </ol>
      </div>
      {wallet.deepLink && <a className="button lime big" href={wallet.deepLink}>{t('On this phone? Open E-Kyash')}</a>}
      <p className="small muted wallet-wait"><span className="pulse-dot" aria-hidden="true" />{t('Waiting for your payment…')}</p>
    </section>
  );
}

export const PROVIDER_BUTTON: Record<string, string> = {
  belizebank: 'Pay by card',
  ekyash: 'Pay with E-Kyash',
  paypal: 'Pay with PayPal',
  test: 'Pay online',
};

export const PROVIDER_NOTE: Record<string, string> = {
  belizebank: 'Visa or Mastercard, on Belize Bank’s secure page. Charged in BZ$.',
  ekyash: 'Scan a QR code with the E-Kyash app, or open it on your phone.',
  paypal: 'Card or PayPal account. Charged in US dollars at BZ$2 = US$1.',
  test: 'Test payments: no money moves.',
};
