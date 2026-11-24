/**
 * The guides at the top of /docs for a site built outside Floreo: a quick
 * start, the embed's components, and the same store with your own code.
 *
 * Every code sample shown is a file in web/examples, imported as it is: the
 * browser tests (e2e/examples.spec.ts) run those same files against a real
 * store, so what is shown here is what was run.
 */

import { type ReactNode, useState } from 'react';
import embedExample from '../../examples/html-embed/index.html?raw';
import fetchExample from '../../examples/html-fetch/index.html?raw';
import reactApp from '../../examples/react/App.jsx?raw';
import reactClient from '../../examples/react/floreo.js?raw';
import { type T, useT } from '../i18n';

/** The guides, for the page's contents: [anchor, title]. */
export const guideLinks = (t: T): Array<[string, string]> => [
  ['quick-start', t('Quick start')],
  ['embed', t('The components')],
  ['your-own-code', t('With your own code')],
  ['paying', t('Paying, and coming back')],
  ['keys', t('Keys and safety')],
];

/** A code sample with its file's name and a way to copy it. */
export function Sample({ name, code }: { name?: string; code: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard.writeText(code).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }).catch(() => {});
  return (
    <div className="doc-sample">
      <div className="row doc-sample-head">
        {name && <span className="mono small">{name}</span>}
        <span className="spacer" />
        <button type="button" className="secondary small-button" onClick={copy}>{copied ? t('Copied') : t('Copy')}</button>
      </div>
      <pre className="doc-code" tabIndex={0}>{code}</pre>
    </div>
  );
}

function Rows({ head, rows }: { head: [string, string]; rows: Array<[string, ReactNode]> }) {
  return (
    <div className="table-wrap">
      <table className="doc-table">
        <thead><tr><th scope="col">{head[0]}</th><th scope="col">{head[1]}</th></tr></thead>
        <tbody>{rows.map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td>{v}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function StoreGuides({ server }: { server: string }) {
  const t = useT();
  // The examples as written, with this server's address in place of the placeholder.
  const here = (code: string) => code.replaceAll('https://YOUR-FLOREO', server);
  const attribute: [string, string] = [t('Attribute'), t('What it does')];
  return (
    <>
      <section id="quick-start" className="doc-guide">
        <h2>{t('Quick start')}</h2>
        <p>{t('You have a site, made with whatever you like. This puts your Floreo store on it: your products, a cart and the checkout, with every way to pay you have turned on. Each paid order gets its BTS receipt. It takes about fifteen minutes, and no server of your own.')}</p>
        <ol className="doc-steps">
          <li><strong>{t('In Floreo, have something to sell.')}</strong> {t('Add a product under Sell → Products and set it to “On sale”, then open your store in Settings → Online store. A new business is in test mode: nothing you do there costs money.')}</li>
          <li><strong>{t('Make a publishable key.')}</strong> {t('Settings → Developers → Connect your site → Make a key. It starts with pk_test_ and is safe to put in a page.')}</li>
          <li><strong>{t('Put the script and the components in your page.')}</strong> {t('The same screen gives you the lines with your store and key filled in. Or start from this whole page: save it as a file, change the three values in the script line, and open it.')}</li>
        </ol>
        <Sample name="index.html" code={here(embedExample)} />
        <ol className="doc-steps" start={4}>
          <li><strong>{t('Open the page and buy something.')}</strong> {t('A file opened from your computer works with a test key. Click a product, add it to the cart, and check out. To try a card, turn on “Test payment” in Settings → Online store: the checkout then shows a pretend card page.')}</li>
          <li><strong>{t('Before it goes on the internet, say where it lives.')}</strong> {t('Add your site’s address to the key (Settings → Developers). Only the sites on a key’s list may use it; on your own computer a test key needs no list.')}</li>
        </ol>
        <p>{t('If something does not show, the component says why on the page while you use a test key, and Settings → Developers → Logs lists each request with what it was answered.')}</p>
      </section>

      <section id="embed" className="doc-guide">
        <h2>{t('The components')}</h2>
        <p>{t('One script, loaded once, defines five elements. Put them where you want them; each one draws itself. Their text takes your page’s font and colour.')}</p>
        <h3>{t('The script tag')}</h3>
        <Rows head={attribute} rows={[
          ['src', t('The script’s address on your Floreo: {url}. Load it from there; do not copy the file, it is kept up to date for you.', { url: `${server}/embed.js` })],
          ['data-store', t('Your store’s name, as in its address.')],
          ['data-key', t('A publishable key (pk_test_… or pk_live_…). Never a secret key.')],
          ['data-lang', t('en or es. Without it, the language of your page (its lang attribute).')],
          ['data-checkout-url', t('A page of your own that holds <floreo-checkout>. Without it, the checkout opens over the page.')],
          ['data-cart', t('none: no cart button is added by itself.')],
        ]} />
        <h3><code>&lt;floreo-products&gt;</code></h3>
        <p>{t('A grid of products. A product opens over the page, where it can be added to the cart.')}</p>
        <Rows head={attribute} rows={[
          ['limit', t('How many at a time (12). “Show more” brings the next ones.')],
          ['sort', 'newest · price_asc · price_desc · title · best_selling'],
          ['collection', t('Only a collection’s products (its handle).')],
          ['category', t('Only a category’s products (its name).')],
          ['search', t('Only products that match these words.')],
          ['handles', t('Only these products, in this order (handles with commas between).')],
          ['on-sale', t('Only products on sale.')],
          ['product-url', t('Your own product page, with {handle} where the product’s handle goes: /product.html?handle={handle}. Cards then link there.')],
        ]} />
        <h3><code>&lt;floreo-product&gt;</code></h3>
        <p>{t('One product: photos, options, how many, add to cart.')}</p>
        <Rows head={attribute} rows={[['handle', t('Which product. Without it, the handle in the page’s address (?handle=…), so one page serves every product.')]]} />
        <h3><code>&lt;floreo-buy-button&gt;</code></h3>
        <p>{t('A button that adds a product to the cart. A product with several variants asks which one first.')}</p>
        <Rows head={attribute} rows={[
          ['handle', t('Which product.')],
          ['variant', t('One variant’s id, to skip the question.')],
          ['label', t('The words on the button.')],
          ['action', t('checkout: straight to the checkout instead of opening the cart.')],
        ]} />
        <h3><code>&lt;floreo-cart&gt;</code></h3>
        <p>{t('The cart button with its count; it opens the cart. Without one on the page, a button appears in the corner once there is something in the cart.')}</p>
        <Rows head={attribute} rows={[['label', t('The words on the button.')], ['floating', t('Keep it fixed in the corner of the window.')]]} />
        <h3><code>&lt;floreo-checkout&gt;</code></h3>
        <p>{t('The checkout on a page of its own: contact, delivery or pickup, a discount code or gift card, how to pay, the total. After paying online the buyer comes back to this page, which then shows the order.')}</p>
        <h3>{t('Your look')}</h3>
        <p>{t('Set these CSS variables on your page (on :root, or on one component) and the components follow:')}</p>
        <Rows head={[t('Variable'), t('What it changes')]} rows={[
          ['--floreo-accent', t('Buttons and what is chosen.')],
          ['--floreo-accent-text', t('The text on buttons.')],
          ['--floreo-radius', t('How round corners are.')],
          ['--floreo-font', t('The font, when it should differ from your page’s.')],
          ['--floreo-text · --floreo-muted', t('Text, and quieter text.')],
          ['--floreo-bg · --floreo-surface · --floreo-border', t('The cart’s and the checkout’s background, their panels and lines.')],
          ['--floreo-gap · --floreo-card-min · --floreo-image-ratio', t('The grid: space between cards, a card’s least width, the shape of photos (1/1).')],
        ]} />
        <p>{t('For anything finer, ::part reaches inside a component: button, card, title, price, image, input, grid, count. For example floreo-products::part(title) { text-transform: uppercase }.')}</p>
        <h3>window.Floreo</h3>
        <p>{t('For your own code. It is there once the script has loaded (the floreo:ready event on window says when).')}</p>
        <Rows head={[t('Call'), t('What it does')]} rows={[
          ['Floreo.on(name, fn)', t('Hear about ready, cart, order, paid and error. Returns a function that stops listening.')],
          ['Floreo.cart.get()', t('The cart: { lines, count, subtotal }.')],
          ['Floreo.cart.addProduct(handle, variantId?, quantity?)', t('Add a product (its first variant for sale when none is named).')],
          ['Floreo.cart.setQuantity(variantId, n) · remove(variantId) · clear()', t('Change the cart.')],
          ['Floreo.cart.open() · close()', t('Show or hide the cart.')],
          ['Floreo.checkout.open()', t('Go to the checkout.')],
          ['Floreo.product.open(handle)', t('Show a product over the page.')],
          ['Floreo.api', t('The store API with your key already in place: info(), products(params), product(handle), collections(), collection(handle), quote(body), order(body, idempotencyKey), getOrder(number, token), pay(number, token, returnUrl), confirmPayment(number, token, paymentId), giftCardBalance(code).')],
        ]} />
      </section>

      <section id="your-own-code" className="doc-guide">
        <h2>{t('With your own code')}</h2>
        <p>{t('The components are made of the same store API you can call yourself, from a page with a publishable key or from your server. The path from a visitor to a paid order is five calls:')}</p>
        <ol className="doc-steps">
          <li>{t('GET /products lists what is for sale; GET /products/{handle} gives one product with its variants. What a buyer orders is a variant.')}</li>
          <li>{t('POST /quote prices the cart (variants and quantities, delivery or pickup): the total with GST, and the ways to pay for this order.')}</li>
          <li>{t('POST /orders places the order, with an Idempotency-Key so a retry never orders twice. Stock is taken at that moment.')}</li>
          <li>{t('Paying online: the answer has payment.url. Send the buyer there; they come back to the returnUrl you gave.')}</li>
          <li>{t('Back on your page: POST …/payments/{id}/confirm says whether it was paid, and GET /orders/{number} gives the order with its receipt.')}</li>
        </ol>
        <p>{t('Plain HTML and JavaScript, the whole of it in one page:')}</p>
        <Sample name="index.html" code={here(fetchExample)} />
        <p>{t('The same in React (a Vite app). A small client first, then the app:')}</p>
        <Sample name="floreo.js" code={here(reactClient)} />
        <Sample name="App.jsx" code={reactApp} />
        <p>{t('These files are in the repository under web/examples, and are run as they are by the browser tests.')}</p>
      </section>

      <section id="paying" className="doc-guide">
        <h2>{t('Paying, and coming back')}</h2>
        <p>{t('Bank transfer, cash on delivery and pay at pickup need nothing more: the order is placed, and the store marks it paid when the money arrives, which issues the receipt. The buyer’s order page (orderUrl) shows how to pay and, later, the receipt.')}</p>
        <p>{t('Paying online (a card through Belize Bank, E-Kyash, PayPal, or the test card in test mode) happens on the provider’s page. Send returnUrl with the order: a page on one of your key’s sites. The buyer comes back to it with three things added to its address:')}</p>
        <Rows head={[t('In the address'), t('What it is')]} rows={[
          ['floreo_order', t('The order’s number.')],
          ['floreo_token', t('The order’s token: with the number, it opens the order for the buyer.')],
          ['floreo_payment', t('The payment to confirm. Instead of it, floreo_cancelled=1 when the buyer gave up at the payment page.')],
        ]} />
        <p>{t('Confirm the payment, then show the order. The components do this by themselves on any page that loads the script. Without a returnUrl the buyer comes back to the order’s own page on your hosted store, which does the same. A buyer who pays and never comes back is not lost: the store asks the provider itself within a few minutes.')}</p>
        <p>{t('With E-Kyash, confirming answers “pending” with a QR code to show (wallet.qr) until the buyer approves in the app; ask again every few seconds. The checkout component does.')}</p>
      </section>

      <section id="keys" className="doc-guide">
        <h2>{t('Keys and safety')}</h2>
        <ul className="doc-list">
          <li>{t('A publishable key in a page is fine: that is what it is for. It can only do what a visitor to your store can do.')}</li>
          <li>{t('A secret key (etd_…) never goes in a page, an app people download, or a public repository. If one gets out, revoke it in Settings → Developers; the store refuses a secret key sent from a page and says so.')}</li>
          <li>{t('List your sites on each publishable key. A live key works from nowhere else; a test key also works on your own computer.')}</li>
          <li>{t('To change a key without a gap: Replace makes a new one beside the old; put it in your site, check under Logs that the old one has gone quiet, then revoke the old one.')}</li>
          <li>{t('Calls from another site never carry cookies, so buyer accounts stay on your hosted store: link to urls.account from GET /info.')}</li>
          <li>{t('Check webhook signatures (below) before trusting what a delivery says.')}</li>
        </ul>
      </section>
    </>
  );
}
