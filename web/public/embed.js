/*!
 * Floreo embed: a store's products, cart and checkout on any site, from one script tag.
 *
 *   <script src="https://YOUR-FLOREO/embed.js" data-store="your-store" data-key="pk_test_..." async></script>
 *
 *   <floreo-products></floreo-products>           a grid of products (collection, category, search, limit, sort, on-sale, handles, product-url)
 *   <floreo-product handle="..."></floreo-product> one product: photos, options, add to cart (or ?handle= in the page's address)
 *   <floreo-buy-button handle="..."></floreo-buy-button>   a button that adds a product to the cart (variant, label, action="checkout")
 *   <floreo-cart></floreo-cart>                    the cart button; without one, a floating one appears once something is added
 *   <floreo-checkout></floreo-checkout>            the checkout on a page of its own; without one, it opens over the page
 *
 * Styling: CSS variables on the page (--floreo-accent, --floreo-accent-text, --floreo-text, --floreo-muted, --floreo-bg,
 * --floreo-surface, --floreo-border, --floreo-radius, --floreo-font) and ::part(button), ::part(card), ::part(title),
 * ::part(price), ::part(image), ::part(input). Text takes the page's own font and colour unless told otherwise.
 *
 * For developers: window.Floreo (api, cart, checkout, on). The key in the tag is a publishable key: it is meant to be
 * seen. A secret key (etd_...) must never be put in a page.
 *
 * This file is served from a fixed address and changes with the platform: load it from there, do not copy it.
 */
(function () {
  'use strict';
  if (window.Floreo && window.Floreo.version) return;
  var VERSION = '1';

  // ---------- settings from the script tag ----------

  var tag = document.currentScript || document.querySelector('script[data-store][src*="embed.js"]');
  var data = (tag && tag.dataset) || {};
  var origin = '';
  try { origin = new URL(tag.src, location.href).origin; } catch (e) { /* no src: data-api must say */ }
  var conf = {
    store: (data.store || '').trim().toLowerCase(),
    key: (data.key || '').trim(),
    base: (data.api || origin).replace(/\/$/, ''),
    lang: (data.lang || document.documentElement.lang || 'en').toLowerCase().slice(0, 2) === 'es' ? 'es' : 'en',
    // Where the site's own checkout page is (one with <floreo-checkout>); without it, the checkout opens over the page.
    checkoutUrl: data.checkoutUrl || '',
    // "none": never add the floating cart button.
    cart: data.cart || 'auto',
  };
  conf.api = conf.base + '/v1/store/' + conf.store;
  var testKey = conf.key.indexOf('pk_test_') === 0;

  // ---------- words ----------

  var ES = {
    'Add to cart': 'Añadir al carrito', 'Added to cart': 'Añadido al carrito', 'Buy now': 'Comprar ahora', 'Sold out': 'Agotado',
    'From {price}': 'Desde {price}', 'Only {n} left': 'Solo quedan {n}', 'Quantity': 'Cantidad', 'Show more': 'Ver más',
    'No products yet.': 'Aún no hay productos.', 'Cart': 'Carrito', 'Your cart': 'Tu carrito', 'Your cart is empty': 'Tu carrito está vacío',
    'Subtotal': 'Subtotal', 'Delivery and discounts are worked out at checkout. Prices include GST.': 'El envío y los descuentos se calculan al pagar. Los precios incluyen GST.',
    'Check out': 'Pagar', 'Remove': 'Quitar', 'Close': 'Cerrar', 'Keep shopping': 'Seguir comprando', 'Checkout': 'Pago',
    'Your details': 'Tus datos', 'Full name': 'Nombre completo', 'Phone': 'Teléfono', 'Email': 'Correo electrónico',
    'Your receipt and order updates are sent here.': 'Aquí enviamos tu recibo y los avisos del pedido.',
    'How you get it': 'Cómo lo recibes', 'Delivery': 'Entrega a domicilio', 'Pickup': 'Recoger en tienda', 'Delivery area': 'Zona de entrega',
    'Pick up at {address}': 'Recoger en {address}', 'Address': 'Dirección', 'Street': 'Calle', 'Town or city': 'Ciudad o pueblo', 'District': 'Distrito',
    'I need a tax invoice for a business': 'Necesito una factura fiscal para una empresa', 'TIN (6 digits)': 'TIN (6 dígitos)', 'Business name': 'Nombre de la empresa',
    'Discount code': 'Código de descuento', 'Gift card': 'Tarjeta de regalo', 'Apply': 'Aplicar', 'Note for the store (optional)': 'Nota para la tienda (opcional)',
    'How you pay': 'Cómo pagas', 'Bank transfer': 'Transferencia bancaria', 'Cash on delivery': 'Pago contra entrega', 'Pay at pickup': 'Pagar al recoger',
    'Pay online now': 'Pagar en línea ahora', 'Pay online now (test card)': 'Pagar en línea ahora (tarjeta de prueba)', 'Card (Belize Bank)': 'Tarjeta (Belize Bank)',
    'PayPal or card': 'PayPal o tarjeta', 'E-Kyash': 'E-Kyash', 'Paid with the gift card': 'Pagado con la tarjeta de regalo',
    'Items': 'Artículos', 'Discount': 'Descuento', 'Total': 'Total', 'GST included': 'GST incluido', 'To pay': 'A pagar',
    'Place order': 'Hacer pedido', 'Placing your order…': 'Enviando tu pedido…', 'Working out the total…': 'Calculando el total…',
    'Thank you, {name}': 'Gracias, {name}', 'Order #{n}': 'Pedido n.º {n}', 'Order #{n} was cancelled': 'El pedido n.º {n} fue cancelado',
    'Paid': 'Pagado', 'Waiting for payment': 'Esperando el pago', 'Your payment went through.': 'Tu pago se realizó correctamente.',
    'Your receipt is on its way to your email.': 'Tu recibo va en camino a tu correo.', 'Download your receipt (PDF)': 'Descargar tu recibo (PDF)',
    'See your order': 'Ver tu pedido', 'Pay now': 'Pagar ahora', 'Try again': 'Intentar de nuevo', 'Checking your payment…': 'Comprobando tu pago…',
    'The payment did not go through.': 'El pago no se completó.', 'The payment was cancelled. Nothing was charged.': 'El pago fue cancelado. No se cobró nada.',
    'We are still waiting for the payment to be confirmed. This page checks by itself.': 'Seguimos esperando la confirmación del pago. Esta página lo comprueba sola.',
    'Scan this code with E-Kyash to pay': 'Escanea este código con E-Kyash para pagar', 'Open E-Kyash': 'Abrir E-Kyash',
    'How to pay': 'Cómo pagar', 'Use order #{n} as the reference.': 'Usa el pedido n.º {n} como referencia.',
    'You will pay {amount} when it is delivered.': 'Pagarás {amount} cuando te lo entreguen.', 'You will pay {amount} when you pick it up.': 'Pagarás {amount} al recogerlo.',
    'Test mode': 'Modo de prueba', 'This is a test store: no money moves and receipts have no fiscal value.': 'Esta es una tienda de prueba: no se mueve dinero y los recibos no tienen valor fiscal.',
    'Could not reach the store. Check your connection and try again.': 'No se pudo conectar con la tienda. Revisa tu conexión e inténtalo de nuevo.',
    'This store is not available right now.': 'Esta tienda no está disponible en este momento.', 'Loading…': 'Cargando…', 'Choose': 'Elige',
    'This product is not available.': 'Este producto no está disponible.', 'Sale': 'Oferta', 'A reminder may be emailed if you leave before ordering.': 'Puede que te enviemos un recordatorio si sales sin terminar el pedido.',
    'Have a discount code or gift card?': '¿Tienes un código de descuento o una tarjeta de regalo?', 'Order summary': 'Resumen del pedido',
    'Applied': 'Aplicado', '{n} in cart': '{n} en el carrito', 'Delivery to {zone}': 'Entrega en {zone}', 'Gift card ending {last4}': 'Tarjeta de regalo terminada en {last4}',
  };
  function t(text, vars) {
    var s = conf.lang === 'es' && ES[text] ? ES[text] : text;
    if (vars) for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }
  var money = function (v) { return 'BZ$' + v; };
  var cents = function (v) { return Math.round(parseFloat(v) * 100); };
  var DISTRICTS = [['1', 'Belize'], ['2', 'Cayo'], ['3', 'Corozal'], ['4', 'Orange Walk'], ['5', 'Stann Creek'], ['6', 'Toledo']];

  // ---------- the store's API ----------

  function FloreoError(code, message, status, details) {
    var e = new Error(message);
    e.name = 'FloreoError';
    e.code = code;
    e.status = status;
    e.details = details;
    return e;
  }

  function setupProblem() {
    if (!conf.store) return 'Floreo: the script tag needs data-store="your-store" (the name in your store\'s address).';
    if (!conf.key) return 'Floreo: the script tag needs data-key="pk_…" (a publishable key from Settings → Developers).';
    if (conf.key.indexOf('pk_') !== 0) return 'Floreo: data-key must be a publishable key (pk_test_… or pk_live_…). Never put a secret key (etd_…) in a page.';
    if (!conf.base) return 'Floreo: load the script from your Floreo address, or add data-api="https://…".';
    return null;
  }

  async function api(path, opts) {
    opts = opts || {};
    var problem = setupProblem();
    if (problem) throw FloreoError('not_set_up', problem, 0);
    var url = new URL(conf.api + path);
    var method = opts.method || 'GET';
    var init = { method: method, headers: {}, credentials: 'omit' };
    // On a GET the key goes in the address, which spares the browser a second request to ask permission first.
    if (method === 'GET') url.searchParams.set('key', conf.key);
    else init.headers.Authorization = 'Bearer ' + conf.key;
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) init.headers['Idempotency-Key'] = opts.idempotencyKey;
    var res;
    try {
      res = await fetch(url.toString(), init);
    } catch (e) {
      throw FloreoError('network_error', t('Could not reach the store. Check your connection and try again.'), 0);
    }
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (!res.ok) {
      var err = (json && json.error) || {};
      throw FloreoError(err.code || 'error', err.message || 'The store answered ' + res.status, res.status, err.details);
    }
    return json;
  }

  var query = function (params) {
    var q = new URLSearchParams();
    for (var k in params) if (params[k] !== undefined && params[k] !== null && params[k] !== '') q.set(k, String(params[k]));
    var s = q.toString();
    return s ? '?' + s : '';
  };
  var tokenQuery = function (token) { return token ? '?t=' + encodeURIComponent(token) : ''; };

  var infoPromise = null;
  var client = {
    info: function () { return infoPromise || (infoPromise = api('/info').catch(function (e) { infoPromise = null; throw e; })); },
    products: function (params) { return api('/products' + query(params || {})); },
    product: function (handle) { return api('/products/' + encodeURIComponent(handle)); },
    collections: function () { return api('/collections'); },
    collection: function (handle) { return api('/collections/' + encodeURIComponent(handle)); },
    quote: function (body) { return api('/quote', { method: 'POST', body: body }); },
    order: function (body, idempotencyKey) { return api('/orders', { method: 'POST', body: body, idempotencyKey: idempotencyKey }); },
    getOrder: function (number, token) { return api('/orders/' + number + tokenQuery(token)); },
    pay: function (number, token, returnUrl) { return api('/orders/' + number + '/pay' + tokenQuery(token), { method: 'POST', body: returnUrl ? { returnUrl: returnUrl } : {} }); },
    confirmPayment: function (number, token, paymentId) { return api('/orders/' + number + '/payments/' + paymentId + '/confirm' + tokenQuery(token), { method: 'POST' }); },
    giftCardBalance: function (code) { return api('/gift-cards/balance', { method: 'POST', body: { code: code } }); },
  };

  // ---------- events ----------

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent('floreo:' + name, { detail: detail })); } catch (e) { /* old browser */ }
  }

  // ---------- the cart, kept on this device ----------

  var CART_KEY = 'floreo.cart.' + conf.store;
  var storage = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: the cart lasts for this page */ } },
  };
  var lines = (storage.get(CART_KEY) || []).filter(function (l) { return l && l.variantId && l.quantity > 0; });
  var cartListeners = [];
  function setLines(next) {
    lines = next;
    storage.set(CART_KEY, lines);
    var snapshot = cart.get();
    cartListeners.forEach(function (fn) { fn(snapshot); });
    emit('cart', snapshot);
  }
  window.addEventListener('storage', function (e) {
    if (e.key !== CART_KEY) return;
    lines = storage.get(CART_KEY) || [];
    var snapshot = cart.get();
    cartListeners.forEach(function (fn) { fn(snapshot); });
  });
  var cart = {
    get: function () {
      return {
        lines: lines.slice(),
        count: lines.reduce(function (n, l) { return n + l.quantity; }, 0),
        subtotal: (lines.reduce(function (n, l) { return n + cents(l.price) * l.quantity; }, 0) / 100).toFixed(2),
      };
    },
    /** add({ variantId, quantity, handle, title, variantTitle, price, imageUrl }) */
    add: function (line) {
      var qty = Math.max(1, Math.floor(line.quantity || 1));
      var found = lines.some(function (l) { return l.variantId === line.variantId; });
      setLines(found
        ? lines.map(function (l) { return l.variantId === line.variantId ? Object.assign({}, l, { quantity: Math.min(9999, l.quantity + qty) }) : l; })
        : lines.concat([{ variantId: line.variantId, quantity: qty, handle: line.handle || '', title: line.title || '', variantTitle: line.variantTitle || null, price: line.price || '0.00', imageUrl: line.imageUrl || null }]));
    },
    /** Add a product by its handle (and one of its variants; the first one for sale when not given). */
    addProduct: async function (handle, variantId, quantity) {
      var p = await client.product(handle);
      var v = variantId ? p.variants.find(function (x) { return x.id === variantId; }) : p.variants.find(function (x) { return x.available; });
      if (!v) throw FloreoError('out_of_stock', t('Sold out'), 409);
      cart.add(lineOf(p, v, quantity || 1));
      return v;
    },
    setQuantity: function (variantId, quantity) {
      var q = Math.floor(quantity);
      setLines(q <= 0 ? lines.filter(function (l) { return l.variantId !== variantId; }) : lines.map(function (l) { return l.variantId === variantId ? Object.assign({}, l, { quantity: Math.min(9999, q) }) : l; }));
    },
    remove: function (variantId) { cart.setQuantity(variantId, 0); },
    clear: function () { setLines([]); },
    subscribe: function (fn) { cartListeners.push(fn); return function () { cartListeners = cartListeners.filter(function (x) { return x !== fn; }); }; },
    open: function () { overlay().openCart(); },
    close: function () { overlay().close(); },
  };
  var lineOf = function (p, v, quantity) {
    return { variantId: v.id, quantity: quantity, handle: p.handle, title: p.title, variantTitle: v.title, price: v.price, imageUrl: (p.imageUrls && p.imageUrls[0]) || null };
  };

  // ---------- building the page ----------

  /** h('div', { class: 'x', onclick: fn, part: 'card' }, child, 'text', [more]) */
  function h(name, props) {
    var el = document.createElement(name);
    for (var k in (props || {})) {
      var v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      // Through the style object, which a page's content security policy allows where it forbids style attributes.
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else el.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  function replace(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    for (var i = 1; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  var CSS = [
    ':host{display:block;font-family:var(--floreo-font,inherit);color:var(--floreo-text,inherit);line-height:1.45;-webkit-text-size-adjust:100%}',
    ':host([hidden]){display:none}',
    '*,*::before,*::after{box-sizing:border-box}',
    'button,input,select,textarea{font:inherit;color:inherit}',
    'img{display:block;max-width:100%}',
    'h2,h3,p{margin:0}',
    '.muted{color:var(--floreo-muted,#6b7280)}',
    '.small{font-size:.875em}',
    '.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:.5em;min-height:2.75em;padding:.6em 1.2em;border:1px solid var(--floreo-accent,#111827);border-radius:var(--floreo-radius,8px);background:var(--floreo-accent,#111827);color:var(--floreo-accent-text,#fff);font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s}',
    '.btn:hover{opacity:.9}',
    '.btn:disabled{opacity:.5;cursor:not-allowed}',
    '.btn.secondary{background:transparent;color:var(--floreo-accent,#111827)}',
    '.btn.block{display:flex;width:100%}',
    '.link{appearance:none;border:0;background:none;padding:0;color:inherit;text-decoration:underline;cursor:pointer}',
    ':focus-visible{outline:2px solid var(--floreo-accent,#111827);outline-offset:2px}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--floreo-card-min,180px),1fr));gap:var(--floreo-gap,1.25rem)}',
    '.card{appearance:none;display:flex;flex-direction:column;gap:.5em;padding:0;border:0;background:none;text-align:left;color:inherit;text-decoration:none;cursor:pointer}',
    '.photo{position:relative;aspect-ratio:var(--floreo-image-ratio,1/1);border-radius:var(--floreo-radius,8px);background:var(--floreo-surface,#f3f4f6);overflow:hidden}',
    '.photo img{width:100%;height:100%;object-fit:cover}',
    '.tag{position:absolute;top:.5em;left:.5em;padding:.15em .6em;border-radius:999px;background:var(--floreo-bg,#fff);color:var(--floreo-text,#111827);font-size:.75em;font-weight:600}',
    '.title{font-weight:600}',
    '.price{display:flex;flex-wrap:wrap;gap:.5em;align-items:baseline}',
    '.was{text-decoration:line-through;color:var(--floreo-muted,#6b7280);font-size:.9em}',
    '.more{display:flex;justify-content:center;margin-top:1.5rem}',
    '.skeleton{min-height:8rem;border-radius:var(--floreo-radius,8px);background:var(--floreo-surface,#f3f4f6)}',
    '.notice{padding:.75em 1em;border:1px solid var(--floreo-border,#e5e7eb);border-radius:var(--floreo-radius,8px);background:var(--floreo-surface,#f9fafb);font-size:.9em}',
    '.notice.bad{border-color:#f0b4b4;background:#fdf3f3;color:#8a1f1f}',
    '.notice.test{border-color:#ecd9a0;background:#fdf8e7;color:#6b5200}',
    '.product{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:2rem;align-items:start}',
    '@container (max-width:560px){.product{grid-template-columns:minmax(0,1fr)}}',
    '.wrap{container-type:inline-size}',
    '.thumbs{display:flex;gap:.5em;margin-top:.5em;flex-wrap:wrap}',
    '.thumbs button{width:3.5em;height:3.5em;padding:0;border:1px solid var(--floreo-border,#e5e7eb);border-radius:6px;overflow:hidden;background:none;cursor:pointer}',
    '.thumbs button[aria-current=true]{border-color:var(--floreo-accent,#111827)}',
    '.thumbs img{width:100%;height:100%;object-fit:cover}',
    '.stack{display:flex;flex-direction:column;gap:1rem}',
    '.stack.tight{gap:.5rem}',
    '.row{display:flex;gap:.75rem;align-items:center}',
    '.row.wrap-row{flex-wrap:wrap}',
    '.row>label.field{flex:1}',
    '.spacer{flex:1}',
    '.product h2{font-size:1.6em;line-height:1.2}',
    '.product .price{font-size:1.25em}',
    '.description p+p{margin-top:.75em}',
    'label.field{display:flex;flex-direction:column;gap:.3em;font-size:.875em;font-weight:600}',
    'label.field .hint{font-weight:400;color:var(--floreo-muted,#6b7280)}',
    'input[type=text],input[type=email],input[type=tel],input[type=number],select,textarea{width:100%;min-height:2.75em;padding:.5em .75em;border:1px solid var(--floreo-border,#d1d5db);border-radius:var(--floreo-radius,8px);background:var(--floreo-bg,#fff);color:var(--floreo-text,#111827);font-weight:400}',
    'textarea{min-height:4.5em;resize:vertical}',
    '.two{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}',
    '@container (max-width:420px){.two{grid-template-columns:1fr}}',
    'fieldset{margin:0;padding:0;border:0;min-width:0}',
    'legend{padding:0;margin-bottom:.6em;font-weight:700;font-size:1.05em}',
    '.choice{display:flex;gap:.6em;align-items:flex-start;padding:.7em .85em;border:1px solid var(--floreo-border,#d1d5db);border-radius:var(--floreo-radius,8px);cursor:pointer;font-weight:400}',
    '.choice:has(input:checked){border-color:var(--floreo-accent,#111827);box-shadow:inset 0 0 0 1px var(--floreo-accent,#111827)}',
    '.choice input{margin-top:.25em;accent-color:var(--floreo-accent,#111827)}',
    '.check{display:flex;gap:.6em;align-items:flex-start;font-weight:400;font-size:.95em;cursor:pointer}',
    '.check input{margin-top:.25em;accent-color:var(--floreo-accent,#111827)}',
    '.summary{padding:1rem;border:1px solid var(--floreo-border,#e5e7eb);border-radius:var(--floreo-radius,8px);background:var(--floreo-surface,#f9fafb)}',
    '.summary .line{display:flex;gap:1rem;justify-content:space-between}',
    '.summary .total{font-weight:700;font-size:1.1em;padding-top:.5rem;margin-top:.25rem;border-top:1px solid var(--floreo-border,#e5e7eb)}',
    '.qty{display:inline-flex;align-items:center;border:1px solid var(--floreo-border,#d1d5db);border-radius:var(--floreo-radius,8px);overflow:hidden}',
    '.qty button{width:2.25em;height:2.25em;border:0;background:none;cursor:pointer;font-size:1em}',
    '.qty span{min-width:2em;text-align:center}',
    '.cart-button{position:relative}',
    '.count{display:inline-flex;min-width:1.5em;height:1.5em;padding:0 .4em;align-items:center;justify-content:center;border-radius:999px;background:var(--floreo-accent-text,#fff);color:var(--floreo-accent,#111827);font-size:.8em;font-weight:700}',
    ':host([floating]){position:fixed;right:1rem;bottom:1rem;z-index:2147483000}',
    ':host([floating]) .btn{box-shadow:0 6px 20px rgba(0,0,0,.18)}',
    // The overlay: cart drawer and dialogs. White, whatever the page behind looks like.
    'dialog{padding:0;border:0;background:var(--floreo-bg,#fff);color:var(--floreo-text,#111827);font-family:var(--floreo-font,inherit);max-width:none;max-height:none}',
    'dialog::backdrop{background:rgba(17,24,39,.45)}',
    'dialog.drawer{position:fixed;inset:0 0 0 auto;width:min(26rem,100vw);height:100dvh;margin:0;box-shadow:-8px 0 30px rgba(0,0,0,.15)}',
    'dialog.modal{width:min(46rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);margin:auto;border-radius:calc(var(--floreo-radius,8px) + 4px);box-shadow:0 20px 60px rgba(0,0,0,.25)}',
    'dialog.modal.narrow{width:min(34rem,calc(100vw - 2rem))}',
    '@media (prefers-reduced-motion:no-preference){dialog.drawer[open]{animation:floreo-in .18s ease-out}dialog.modal[open]{animation:floreo-up .18s ease-out}}',
    '@keyframes floreo-in{from{transform:translateX(1.5rem);opacity:0}}',
    '@keyframes floreo-up{from{transform:translateY(.75rem);opacity:0}}',
    '.pane{display:flex;flex-direction:column;height:100%;max-height:inherit}',
    '.pane-head{display:flex;align-items:center;gap:.75rem;padding:1rem 1.25rem;border-bottom:1px solid var(--floreo-border,#e5e7eb)}',
    '.pane-head h2{font-size:1.15em}',
    '.pane-body{flex:1;overflow:auto;padding:1.25rem;container-type:inline-size}',
    '.pane-foot{padding:1rem 1.25rem;border-top:1px solid var(--floreo-border,#e5e7eb)}',
    '.x{appearance:none;width:2.25em;height:2.25em;border:0;border-radius:999px;background:none;font-size:1.1em;cursor:pointer}',
    '.x:hover{background:var(--floreo-surface,#f3f4f6)}',
    '.badge{display:inline-block;padding:.1em .6em;border-radius:999px;background:#fdf8e7;color:#6b5200;border:1px solid #ecd9a0;font-size:.75em;font-weight:600}',
    '.badge.ok{background:#ecf8f0;color:#14603a;border-color:#b5dfc6}',
    '.cart-line{display:grid;grid-template-columns:4rem 1fr auto;gap:.75rem;align-items:start;padding:.75rem 0;border-bottom:1px solid var(--floreo-border,#e5e7eb)}',
    '.cart-line .photo{width:4rem;aspect-ratio:1/1}',
    '.qr{width:14rem;height:14rem;margin:0 auto}',
    '.center{text-align:center}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
  ].join('\n');

  var sheet = null;
  function styled(root) {
    try {
      if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); }
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      root.appendChild(h('style', null, CSS));
    }
    return root;
  }

  /** What to show when something went wrong: the reason for the person building the site, a plain line for buyers. */
  function problemBox(error) {
    var message = error && error.message ? error.message : String(error);
    var forBuilder = testKey || !error || error.code === 'not_set_up';
    try { console.error('[Floreo] ' + (error && error.code ? error.code + ': ' : '') + message); } catch (e) { /* no console */ }
    emit('error', { code: (error && error.code) || 'error', message: message });
    var buyerSafe = error && (error.status === 409 || error.status === 422 || error.code === 'network_error' || error.code === 'not_found' || error.code === 'store_closed' || error.code === 'out_of_stock');
    return h('div', { class: 'notice bad', role: 'alert' }, forBuilder || buyerSafe ? message : t('This store is not available right now.'));
  }
  var testNotice = function () { return h('div', { class: 'notice test small' }, h('strong', null, t('Test mode') + '. '), t('This is a test store: no money moves and receipts have no fiscal value.')); };
  var loading = function () { return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': t('Loading…') }); };

  // ---------- one product ----------

  function priceLine(price, compareAt) {
    return h('div', { class: 'price', part: 'price' }, h('span', null, money(price)), compareAt ? h('span', { class: 'was' }, money(compareAt)) : null);
  }

  /** A product with its photos, options and "Add to cart", drawn into `into`. */
  function productView(into, handle, opts) {
    opts = opts || {};
    replace(into, loading());
    client.product(handle).then(function (p) {
      var optionNames = p.options || [];
      var first = p.variants.find(function (v) { return v.available; }) || p.variants[0];
      if (!first) return replace(into, h('div', { class: 'notice' }, t('This product is not available.')));
      var chosen = { option1: first.option1, option2: first.option2 };
      var quantity = 1;
      var shown = 0;
      var buy = h('div', { class: 'stack' });
      var gallery = h('div');
      var variant = function () {
        return p.variants.find(function (v) { return (optionNames.length < 1 || v.option1 === chosen.option1) && (optionNames.length < 2 || v.option2 === chosen.option2); }) || null;
      };
      var drawGallery = function () {
        var urls = p.imageUrls || [];
        replace(gallery,
          h('div', { class: 'photo', part: 'image' }, urls[shown] ? h('img', { src: urls[shown], alt: p.title }) : null, p.badge ? h('span', { class: 'tag' }, p.badge) : null),
          urls.length > 1 ? h('div', { class: 'thumbs' }, urls.map(function (u, i) {
            return h('button', { type: 'button', 'aria-current': i === shown ? 'true' : 'false', 'aria-label': p.title + ' ' + (i + 1), onclick: function () { shown = i; drawGallery(); } }, h('img', { src: u, alt: '', loading: 'lazy' }));
          })) : null);
      };
      var drawBuy = function () {
        var v = variant();
        var selects = optionNames.map(function (name, i) {
          var field = i === 0 ? 'option1' : 'option2';
          var values = [];
          p.variants.forEach(function (x) { if (values.indexOf(x[field]) < 0) values.push(x[field]); });
          return h('label', { class: 'field' }, name, h('select', { part: 'input', onchange: function (e) { chosen[field] = e.target.value; quantity = 1; drawBuy(); } },
            values.map(function (value) { return h('option', { value: value, selected: chosen[field] === value }, value); })));
        });
        var max = v && v.left !== null && v.left !== undefined ? v.left : 9999;
        replace(buy,
          h('h2', { part: 'title' }, p.title),
          v ? priceLine(v.price, v.compareAt) : null,
          selects,
          v && v.available ? h('div', { class: 'row wrap-row' },
            h('div', { class: 'qty', role: 'group', 'aria-label': t('Quantity') },
              h('button', { type: 'button', 'aria-label': '−', onclick: function () { quantity = Math.max(1, quantity - 1); drawBuy(); } }, '−'),
              h('span', { 'aria-live': 'polite' }, quantity),
              h('button', { type: 'button', 'aria-label': '+', onclick: function () { quantity = Math.min(max, quantity + 1); drawBuy(); } }, '+')),
            h('button', { class: 'btn', part: 'button', type: 'button', onclick: function () {
              cart.add(lineOf(p, v, quantity));
              if (opts.onAdded) opts.onAdded();
              else if (conf.cart !== 'none') cart.open();
            } }, t('Add to cart'))) : h('button', { class: 'btn', part: 'button', type: 'button', disabled: true }, t('Sold out')),
          v && v.available && v.left ? h('p', { class: 'small muted' }, t('Only {n} left', { n: v.left })) : null,
          p.description ? h('div', { class: 'description' }, p.description.split(/\n{2,}/).map(function (para) { return h('p', null, para); })) : null);
      };
      drawGallery();
      drawBuy();
      replace(into, h('div', { class: 'wrap' }, h('div', { class: 'product' }, gallery, buy)));
    }).catch(function (e) { replace(into, problemBox(e)); });
  }

  // ---------- the cart ----------

  function cartView(into, opts) {
    var draw = function () {
      var c = cart.get();
      if (!c.lines.length) return replace(into, h('p', { class: 'muted' }, t('Your cart is empty')));
      replace(into,
        h('div', null, c.lines.map(function (l) {
          return h('div', { class: 'cart-line' },
            h('div', { class: 'photo' }, l.imageUrl ? h('img', { src: l.imageUrl, alt: '' }) : null),
            h('div', { class: 'stack tight' },
              h('div', null, h('div', { class: 'title' }, l.title), l.variantTitle ? h('div', { class: 'small muted' }, l.variantTitle) : null),
              h('div', { class: 'row' },
                h('div', { class: 'qty', role: 'group', 'aria-label': t('Quantity') },
                  h('button', { type: 'button', 'aria-label': '−', onclick: function () { cart.setQuantity(l.variantId, l.quantity - 1); } }, '−'),
                  h('span', null, l.quantity),
                  h('button', { type: 'button', 'aria-label': '+', onclick: function () { cart.setQuantity(l.variantId, l.quantity + 1); } }, '+')),
                h('button', { class: 'link small muted', type: 'button', onclick: function () { cart.remove(l.variantId); } }, t('Remove')))),
            h('div', null, money((cents(l.price) * l.quantity / 100).toFixed(2))));
        })),
        h('div', { class: 'stack', style: 'margin-top:1rem' },
          h('div', { class: 'row' }, h('strong', null, t('Subtotal')), h('span', { class: 'spacer' }), h('strong', null, money(c.subtotal))),
          h('p', { class: 'small muted' }, t('Delivery and discounts are worked out at checkout. Prices include GST.')),
          h('button', { class: 'btn block', part: 'button', type: 'button', onclick: opts.onCheckout }, t('Check out'))));
    };
    draw();
    return cart.subscribe(draw);
  }

  // ---------- checkout ----------

  var PAY_LABEL = { bank_transfer: 'Bank transfer', cash_on_delivery: 'Cash on delivery', pay_at_pickup: 'Pay at pickup', gift_card: 'Paid with the gift card' };
  var ONLINE_LABEL = { test: 'Pay online now (test card)', paypal: 'PayPal or card', belizebank: 'Card (Belize Bank)', ekyash: 'E-Kyash' };
  var pageUrl = function () {
    var u = new URL(location.href);
    ['floreo_order', 'floreo_token', 'floreo_payment', 'floreo_cancelled'].forEach(function (k) { u.searchParams.delete(k); });
    return u.toString();
  };
  var newKey = function () { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(16).slice(2); };

  /** The checkout form, drawn into `into`. opts.onOrder(order) is called once the order is placed and stays on this page. */
  function checkoutView(into, opts) {
    opts = opts || {};
    if (!cart.get().lines.length) return replace(into, h('p', { class: 'muted' }, t('Your cart is empty')));
    replace(into, loading());
    client.info().then(function (info) {
      var state = {
        fulfillment: info.delivery.enabled && info.delivery.zones.length ? 'delivery' : 'pickup',
        zone: (info.delivery.zones[0] || {}).name || '',
        payment: '', code: '', gift: '', invoice: false, busy: false, quote: null, key: newKey(),
      };
      var f = {};
      var input = function (name, type, attrs) { return (f[name] = h('input', Object.assign({ type: type || 'text', name: name, part: 'input' }, attrs || {}))); };
      var field = function (label, control, hint) { return h('label', { class: 'field' }, label, control, hint ? h('span', { class: 'hint' }, hint) : null); };
      var errorBox = h('div');
      var summary = h('div', { class: 'summary stack tight', 'aria-live': 'polite' });
      var payments = h('div', { class: 'stack tight' });
      var addressBox = h('div', { class: 'stack' });
      var invoiceBox = h('div', { class: 'stack' });
      var zoneBox = h('div');
      var codeNote = h('div', { class: 'small' });
      var giftNote = h('div', { class: 'small' });
      var submit = h('button', { class: 'btn block', part: 'button', type: 'submit' }, t('Place order'));

      var body = function () {
        return Object.assign({ lines: cart.get().lines.map(function (l) { return { variantId: l.variantId, quantity: l.quantity }; }), fulfillment: state.fulfillment },
          state.fulfillment === 'delivery' ? { zone: state.zone } : {}, state.code ? { discountCode: state.code } : {}, state.gift ? { giftCard: state.gift } : {});
      };
      var needsAddress = function () { return state.fulfillment === 'delivery' || state.invoice; };

      var drawSummary = function () {
        var q = state.quote;
        if (!q) return replace(summary, h('p', { class: 'muted small' }, t('Working out the total…')));
        replace(summary,
          h('strong', null, t('Order summary')),
          q.lines.map(function (l) { return h('div', { class: 'line small' }, h('span', null, l.quantity + ' × ' + l.productTitle + (l.variantTitle ? ' (' + l.variantTitle + ')' : '')), h('span', null, money(l.listTotal || l.total))); }),
          q.delivery ? h('div', { class: 'line small' }, h('span', null, t('Delivery to {zone}', { zone: q.delivery.zone })), h('span', null, money(q.delivery.total))) : null,
          q.discount ? h('div', { class: 'line small' }, h('span', null, t('Discount') + ' (' + q.discount.code + ')'), h('span', null, '−' + money(q.discount.saved))) : null,
          h('div', { class: 'line total' }, h('span', null, t('Total')), h('span', null, money(q.totals.total))),
          h('div', { class: 'line small muted' }, h('span', null, t('GST included')), h('span', null, money(q.totals.gst))),
          q.giftCard ? h('div', { class: 'line small' }, h('span', null, t('Gift card ending {last4}', { last4: q.giftCard.last4 })), h('span', null, '−' + money(q.giftCard.applied))) : null,
          q.giftCard ? h('div', { class: 'line total' }, h('span', null, t('To pay')), h('span', null, money(q.due))) : null);
      };
      var drawPayments = function () {
        var methods = state.quote ? state.quote.paymentMethods : [];
        if (methods.indexOf(state.payment) < 0) state.payment = methods[0] || '';
        replace(payments, methods.map(function (m) {
          var label = m === 'online' ? ONLINE_LABEL[info.payments.online] || 'Pay online now' : PAY_LABEL[m];
          return h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'payment', value: m, checked: state.payment === m, onchange: function () { state.payment = m; } }), h('span', null, t(label)));
        }));
      };
      var drawAddress = function () {
        replace(addressBox, needsAddress() ? [
          h('strong', null, t('Address')),
          field(t('Street'), f.street), h('div', { class: 'two' }, field(t('Town or city'), f.city), field(t('District'), f.district)),
        ] : null);
        f.street.required = f.city.required = needsAddress();
      };
      var drawInvoice = function () {
        replace(invoiceBox, state.invoice ? h('div', { class: 'two' }, field(t('TIN (6 digits)'), f.tin), field(t('Business name'), f.business)) : null);
        f.tin.required = f.business.required = state.invoice;
      };
      var drawZone = function () {
        replace(zoneBox, state.fulfillment === 'delivery' && info.delivery.zones.length
          ? field(t('Delivery area'), h('select', { part: 'input', onchange: function (e) { state.zone = e.target.value; requote(); } },
            info.delivery.zones.map(function (z) { return h('option', { value: z.name, selected: z.name === state.zone }, z.name + ' · ' + money(z.fee)); })))
          : state.fulfillment === 'pickup' && info.pickup.address ? h('p', { class: 'small muted' }, t('Pick up at {address}', { address: info.pickup.address })) : null);
      };

      var quoting = 0;
      var requote = function () {
        var mine = ++quoting;
        return client.quote(body()).then(function (q) {
          if (mine !== quoting) return;
          state.quote = q;
          replace(errorBox);
          drawSummary();
          drawPayments();
        }).catch(function (e) {
          if (mine !== quoting) return;
          // A code or card that does not work is said beside it, and the order is priced without it.
          if (state.gift && String(e.code).indexOf('gift_card') === 0) { state.gift = ''; replace(giftNote, h('span', { style: 'color:#8a1f1f' }, e.message)); return requote(); }
          if (state.code && e.status === 422) { state.code = ''; replace(codeNote, h('span', { style: 'color:#8a1f1f' }, e.message)); return requote(); }
          state.quote = null;
          drawSummary();
          drawPayments();
          replace(errorBox, problemBox(e));
        });
      };

      input('name', 'text', { required: true, autocomplete: 'name', maxlength: 200 });
      input('phone', 'tel', { required: true, autocomplete: 'tel', minlength: 7, maxlength: 30, pattern: '[0-9+\\(\\)\\-\\s]+', inputmode: 'tel' });
      input('email', 'email', { autocomplete: 'email', maxlength: 254 });
      input('street', 'text', { autocomplete: 'address-line1', maxlength: 200 });
      input('city', 'text', { autocomplete: 'address-level2', maxlength: 100 });
      f.district = h('select', { name: 'district', part: 'input' }, DISTRICTS.map(function (d) { return h('option', { value: d[0] }, d[1]); }));
      input('tin', 'text', { inputmode: 'numeric', pattern: '\\d{6}', maxlength: 6 });
      input('business', 'text', { maxlength: 300 });
      input('code', 'text', { maxlength: 40, autocomplete: 'off' });
      input('gift', 'text', { maxlength: 40, autocomplete: 'off' });
      f.note = h('textarea', { name: 'note', maxlength: 1000, part: 'input' });

      var ways = [];
      if (info.delivery.enabled && info.delivery.zones.length) ways.push(['delivery', 'Delivery']);
      if (info.pickup.enabled) ways.push(['pickup', 'Pickup']);

      var form = h('form', { class: 'stack', novalidate: false, onsubmit: function (e) {
        e.preventDefault();
        if (state.busy || !state.quote || !state.payment) return;
        state.busy = true;
        submit.disabled = true;
        replace(submit, t('Placing your order…'));
        replace(errorBox);
        var online = state.payment === 'online';
        var order = Object.assign(body(), {
          paymentMethod: state.payment,
          customer: Object.assign({ name: f.name.value.trim(), phone: f.phone.value.trim() }, f.email.value.trim() ? { email: f.email.value.trim() } : {}),
        }, needsAddress() ? { address: { street: f.street.value.trim(), city: f.city.value.trim(), districtCode: f.district.value } } : {},
        state.invoice ? { business: { tin: f.tin.value.trim(), name: f.business.value.trim() } } : {},
        f.note.value.trim() ? { note: f.note.value.trim() } : {},
        online && location.protocol !== 'file:' ? { returnUrl: pageUrl() } : {});
        if (!(state.gift && state.quote.giftCard)) delete order.giftCard;
        client.order(order, state.key).then(function (placed) {
          cart.clear();
          emit('order', { number: placed.number, token: placed.token, orderUrl: placed.orderUrl, totals: placed.totals, test: placed.test });
          // Paying online: on to the payment page; the buyer comes back to this page (or to the order's own page).
          if (placed.payment && placed.payment.url) { location.assign(placed.payment.url); return; }
          if (opts.onOrder) opts.onOrder(placed);
          else orderView(into, placed.number, placed.token, { problem: placed.payment && placed.payment.error });
        }).catch(function (e) {
          state.busy = false;
          submit.disabled = false;
          replace(submit, t('Place order'));
          replace(errorBox, problemBox(e));
          errorBox.scrollIntoView({ block: 'nearest' });
          requote();
        });
      } },
        info.test ? testNotice() : null,
        h('fieldset', { class: 'stack' }, h('legend', null, t('Your details')),
          field(t('Full name'), f.name),
          h('div', { class: 'two' }, field(t('Phone'), f.phone), field(t('Email'), f.email, t('Your receipt and order updates are sent here.')))),
        h('fieldset', { class: 'stack' }, h('legend', null, t('How you get it')),
          ways.length > 1 ? h('div', { class: 'two' }, ways.map(function (w) {
            return h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'fulfillment', value: w[0], checked: state.fulfillment === w[0], onchange: function () { state.fulfillment = w[0]; drawZone(); drawAddress(); requote(); } }), h('span', null, t(w[1])));
          })) : null,
          zoneBox, addressBox,
          h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: function (e) { state.invoice = e.target.checked; drawInvoice(); drawAddress(); } }), h('span', null, t('I need a tax invoice for a business'))),
          invoiceBox),
        h('details', null, h('summary', { class: 'small' }, t('Have a discount code or gift card?')),
          h('div', { class: 'stack', style: 'margin-top:.75rem' },
            h('div', { class: 'stack tight' }, h('div', { class: 'row', style: 'align-items:flex-end' }, field(t('Discount code'), f.code),
              h('button', { class: 'btn secondary', type: 'button', onclick: function () { state.code = f.code.value.trim(); replace(codeNote); requote().then(function () { if (state.code && state.quote && state.quote.discount) replace(codeNote, h('span', { class: 'muted' }, t('Applied'))); }); } }, t('Apply'))), codeNote),
            h('div', { class: 'stack tight' }, h('div', { class: 'row', style: 'align-items:flex-end' }, field(t('Gift card'), f.gift),
              h('button', { class: 'btn secondary', type: 'button', onclick: function () { state.gift = f.gift.value.trim(); replace(giftNote); requote().then(function () { if (state.gift && state.quote && state.quote.giftCard) replace(giftNote, h('span', { class: 'muted' }, t('Applied'))); }); } }, t('Apply'))), giftNote))),
        field(t('Note for the store (optional)'), f.note),
        h('fieldset', { class: 'stack' }, h('legend', null, t('How you pay')), payments),
        summary,
        errorBox,
        submit);
      replace(into, h('div', { class: 'wrap' }, form));
      drawZone();
      drawAddress();
      drawInvoice();
      drawSummary();
      requote();
    }).catch(function (e) { replace(into, problemBox(e)); });
  }

  // ---------- an order, after it is placed ----------

  /** The order as the buyer sees it: thank you, how to pay or that it is paid, the receipt. opts: paymentId, cancelled, problem. */
  function orderView(into, number, token, opts) {
    opts = opts || {};
    var timer = null;
    var stop = function () { if (timer) { clearInterval(timer); timer = null; } };
    var payNow = function (button) {
      button.disabled = true;
      client.pay(number, token, location.protocol !== 'file:' ? pageUrl() : undefined).then(function (r) { location.assign(r.url); }).catch(function (e) {
        button.disabled = false;
        button.parentNode.insertBefore(problemBox(e), button);
      });
    };
    var show = function (note) {
      client.getOrder(number, token).then(function (o) {
        var first = (o.customer.name || '').split(' ')[0];
        var paid = o.paymentStatus === 'paid';
        var canPay = o.online && o.online.canPay && !paid && o.status !== 'cancelled';
        var due = money(o.amountDue || o.totals.total);
        if (paid) emit('paid', { number: o.number, orderUrl: o.orderUrl });
        replace(into, h('div', { class: 'stack' },
          o.test ? testNotice() : null,
          h('div', { class: 'stack tight' },
            h('h2', null, o.status === 'cancelled' ? t('Order #{n} was cancelled', { n: o.number }) : t('Thank you, {name}', { name: first })),
            o.status === 'cancelled' ? null : h('div', { class: 'row' }, h('span', null, t('Order #{n}', { n: o.number })), h('span', { class: paid ? 'badge ok' : 'badge' }, paid ? t('Paid') : t('Waiting for payment')))),
          note || null,
          paid ? h('p', null, t('Your payment went through.') + (o.document ? '' : ' ' + t('Your receipt is on its way to your email.'))) : null,
          !paid && o.instructions ? h('div', { class: 'summary stack tight' }, h('strong', null, t('How to pay')), h('p', { style: 'white-space:pre-line' }, o.instructions), h('p', { class: 'small muted' }, t('Use order #{n} as the reference.', { n: o.number }))) : null,
          !paid && o.status !== 'cancelled' && o.paymentMethod === 'cash_on_delivery' ? h('p', null, t('You will pay {amount} when it is delivered.', { amount: due })) : null,
          !paid && o.status !== 'cancelled' && o.paymentMethod === 'pay_at_pickup' ? h('p', null, t('You will pay {amount} when you pick it up.', { amount: due })) : null,
          h('div', { class: 'summary stack tight' },
            o.lines.map(function (l) { return h('div', { class: 'line small' }, h('span', null, Number(l.quantity) + ' × ' + l.productTitle + (l.variantTitle ? ' (' + l.variantTitle + ')' : '')), h('span', null, money(l.total))); }),
            h('div', { class: 'line total' }, h('span', null, t('Total')), h('span', null, money(o.totals.total)))),
          canPay ? h('button', { class: 'btn block', part: 'button', type: 'button', onclick: function (e) { payNow(e.currentTarget); } }, opts.paymentId || opts.cancelled ? t('Try again') : t('Pay now')) : null,
          o.document && o.document.pdfUrl ? h('a', { class: 'btn block', part: 'button', href: o.document.pdfUrl, target: '_blank', rel: 'noopener' }, t('Download your receipt (PDF)')) : null,
          h('a', { class: 'btn secondary block', href: o.orderUrl, target: '_blank', rel: 'noopener' }, t('See your order')),
          opts.onClose ? h('button', { class: 'link center', type: 'button', onclick: opts.onClose }, t('Keep shopping')) : null));
      }).catch(function (e) { replace(into, problemBox(e)); });
    };
    var note = function (text, bad) { return h('div', { class: bad ? 'notice bad' : 'notice' }, text); };

    if (opts.cancelled) { show(note(t('The payment was cancelled. Nothing was charged.'))); return stop; }
    if (opts.problem) { show(note(opts.problem, true)); return stop; }
    if (!opts.paymentId) { show(); return stop; }

    // Back from the payment page: ask whether it went through.
    replace(into, h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('Checking your payment…')), loading()));
    var tries = 0;
    var check = function () {
      client.confirmPayment(number, token, opts.paymentId).then(function (r) {
        if (r.status === 'paid') { stop(); return show(); }
        if (r.status === 'pending') {
          if (!timer) timer = setInterval(function () { if (document.visibilityState === 'visible' && ++tries < 200) check(); }, 3000);
          // A wallet (E-Kyash): the code to scan stays up while we wait.
          if (r.wallet && r.wallet.qr) {
            if (!into.querySelector('.qr')) {
              replace(into, h('div', { class: 'stack center' }, h('h2', null, t('Scan this code with E-Kyash to pay')), h('img', { class: 'qr', src: r.wallet.qr, alt: 'E-Kyash QR' }),
                r.wallet.deepLink ? h('a', { class: 'btn', part: 'button', href: r.wallet.deepLink }, t('Open E-Kyash')) : null,
                h('p', { class: 'small muted' }, t('We are still waiting for the payment to be confirmed. This page checks by itself.'))));
            }
          } else if (tries === 0) show(note(t('We are still waiting for the payment to be confirmed. This page checks by itself.')));
          return;
        }
        stop();
        show(note(t('The payment did not go through.') + (r.problem ? ' ' + r.problem : ''), true));
      }).catch(function (e) { stop(); show(problemBox(e)); });
    };
    check();
    return stop;
  }

  // ---------- the overlay: the cart drawer and dialogs over the page ----------

  var overlayApi = null;
  function overlay() {
    if (overlayApi) return overlayApi;
    var host = document.createElement('floreo-overlay');
    var root = styled(host.attachShadow({ mode: 'open' }));
    var dialog = h('dialog', { 'aria-modal': 'true' });
    root.appendChild(dialog);
    document.body.appendChild(host);
    var cleanup = null;
    var close = function () {
      if (cleanup) { cleanup(); cleanup = null; }
      if (dialog.open) dialog.close();
    };
    dialog.addEventListener('close', function () { if (cleanup) { cleanup(); cleanup = null; } });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) close(); });
    var open = function (kind, title, build, foot) {
      if (cleanup) { cleanup(); cleanup = null; }
      var bodyEl = h('div', { class: 'pane-body' });
      dialog.className = kind;
      replace(dialog, h('div', { class: 'pane' },
        h('div', { class: 'pane-head' }, h('h2', null, title), testKey ? h('span', { class: 'badge' }, t('Test mode')) : null, h('span', { class: 'spacer' }), h('button', { class: 'x', type: 'button', 'aria-label': t('Close'), onclick: close }, '✕')),
        bodyEl, foot || null));
      cleanup = build(bodyEl) || null;
      if (!dialog.open) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
    };
    overlayApi = {
      close: close,
      openCart: function () { open('drawer', t('Your cart'), function (b) { return cartView(b, { onCheckout: function () { startCheckout(); } }); }); },
      openProduct: function (handle) { open('modal', '', function (b) { productView(b, handle, { onAdded: function () { overlayApi.openCart(); } }); }); },
      openCheckout: function () { open('modal narrow', t('Checkout'), function (b) { checkoutView(b, { onOrder: function (placed) { overlayApi.openOrder(placed.number, placed.token, { problem: placed.payment && placed.payment.error }); } }); }); },
      openOrder: function (number, token, opts) { open('modal narrow', t('Order #{n}', { n: number }), function (b) { return orderView(b, number, token, Object.assign({ onClose: close }, opts || {})); }); },
    };
    return overlayApi;
  }

  /** "Check out" was pressed: the site's own checkout page when it has one, else the checkout over this page. */
  function startCheckout() {
    var inline = document.querySelector('floreo-checkout');
    if (inline) { overlay().close(); inline.scrollIntoView({ behavior: 'smooth', block: 'start' }); if (inline.refresh) inline.refresh(); return; }
    if (conf.checkoutUrl) { location.assign(conf.checkoutUrl); return; }
    overlay().openCheckout();
  }

  // ---------- the elements ----------

  function define(name, methods) {
    if (customElements.get(name)) return;
    class El extends HTMLElement {
      static get observedAttributes() { return methods.attrs || []; }
      connectedCallback() {
        if (!this.shadowRoot) {
          styled(this.attachShadow({ mode: 'open' }));
          this.mount = this.shadowRoot.appendChild(h('div'));
        }
        var problem = setupProblem();
        if (problem) return replace(this.mount, problemBox(FloreoError('not_set_up', problem, 0)));
        methods.render.call(this);
      }
      disconnectedCallback() { if (this.off) { this.off(); this.off = null; } }
      attributeChangedCallback() { if (this.mount && this.isConnected) methods.render.call(this); }
    }
    for (var k in methods) if (k !== 'render' && k !== 'attrs') El.prototype[k] = methods[k];
    customElements.define(name, El);
  }

  define('floreo-products', {
    attrs: ['collection', 'category', 'search', 'sort', 'limit', 'on-sale', 'handles', 'product-url'],
    render: function () {
      var self = this;
      var mount = this.mount;
      var limit = Math.min(100, Math.max(1, parseInt(this.getAttribute('limit') || '12', 10) || 12));
      var grid = h('div', { class: 'grid', part: 'grid' });
      var more = h('div', { class: 'more' });
      var productUrl = this.getAttribute('product-url');
      var card = function (p) {
        var inside = [
          h('div', { class: 'photo', part: 'image' }, p.imageUrl ? h('img', { src: p.imageUrl, alt: '', loading: 'lazy' }) : null,
            p.soldOut ? h('span', { class: 'tag' }, t('Sold out')) : p.badge ? h('span', { class: 'tag' }, p.badge) : p.compareAt ? h('span', { class: 'tag' }, t('Sale')) : null),
          h('div', { class: 'title', part: 'title' }, p.title),
          h('div', { class: 'price', part: 'price' }, h('span', null, p.priceVaries ? t('From {price}', { price: money(p.price) }) : money(p.price)), p.compareAt ? h('span', { class: 'was' }, money(p.compareAt)) : null),
        ];
        // The site's own product page when it has one ("/product.html?handle={handle}"), else the product opens over this page.
        if (productUrl) return h('a', { class: 'card', part: 'card', href: productUrl.split('{handle}').join(encodeURIComponent(p.handle)) }, inside);
        return h('button', { class: 'card', part: 'card', type: 'button', onclick: function () { overlay().openProduct(p.handle); } }, inside);
      };
      var load = function (cursor) {
        return client.products({
          limit: limit, cursor: cursor, collection: self.getAttribute('collection'), category: self.getAttribute('category'), q: self.getAttribute('search'),
          sort: self.getAttribute('sort'), handles: self.getAttribute('handles'), onSale: self.hasAttribute('on-sale') ? '1' : undefined,
        }).then(function (page) {
          if (!cursor) replace(mount, page.data.length ? [grid, more] : h('p', { class: 'muted' }, t('No products yet.')));
          page.data.forEach(function (p) { grid.appendChild(card(p)); });
          replace(more, page.nextCursor ? h('button', { class: 'btn secondary', part: 'button', type: 'button', onclick: function (e) { e.currentTarget.disabled = true; load(page.nextCursor); } }, t('Show more')) : null);
        }).catch(function (e) { replace(cursor ? more : mount, problemBox(e)); });
      };
      replace(mount, h('div', { class: 'grid' }, [0, 1, 2, 3].map(loading)));
      load();
    },
  });

  define('floreo-product', {
    attrs: ['handle'],
    render: function () {
      var handle = this.getAttribute('handle') || new URLSearchParams(location.search).get(this.getAttribute('handle-param') || 'handle');
      if (!handle) return replace(this.mount, problemBox(FloreoError('not_set_up', 'Floreo: <floreo-product> needs handle="…" (or ?handle=… in the page\'s address).', 0)));
      productView(this.mount, handle);
    },
  });

  define('floreo-buy-button', {
    attrs: ['handle', 'variant', 'label', 'action'],
    render: function () {
      var self = this;
      var handle = this.getAttribute('handle');
      if (!handle) return replace(this.mount, problemBox(FloreoError('not_set_up', 'Floreo: <floreo-buy-button> needs handle="…" (the product\'s name in its address).', 0)));
      var checkout = this.getAttribute('action') === 'checkout';
      var label = this.getAttribute('label') || t(checkout ? 'Buy now' : 'Add to cart');
      var note = h('span', { class: 'sr', 'aria-live': 'polite' });
      var button = h('button', { class: 'btn', part: 'button', type: 'button', onclick: function () {
        button.disabled = true;
        client.product(handle).then(function (p) {
          button.disabled = false;
          var wanted = self.getAttribute('variant');
          // Several to choose from and none named: the buyer picks, over the page.
          if (!wanted && p.variants.length > 1) return overlay().openProduct(handle);
          var v = wanted ? p.variants.find(function (x) { return x.id === wanted; }) : p.variants[0];
          if (!v || !v.available) { button.disabled = true; replace(button, t('Sold out')); return; }
          cart.add(lineOf(p, v, 1));
          replace(note, t('Added to cart'));
          if (checkout) startCheckout();
          else if (conf.cart !== 'none') cart.open();
        }).catch(function (e) { button.disabled = false; replace(self.mount, button, problemBox(e)); });
      } }, label);
      replace(this.mount, button, note);
    },
  });

  define('floreo-cart', {
    attrs: ['label'],
    render: function () {
      var self = this;
      if (this.off) this.off();
      var draw = function (c) {
        replace(self.mount, h('button', { class: 'btn cart-button', part: 'button', type: 'button', 'aria-label': t('Cart') + ': ' + t('{n} in cart', { n: c.count }), onclick: function () { cart.open(); } },
          self.getAttribute('label') || t('Cart'), h('span', { class: 'count', part: 'count' }, c.count)));
      };
      draw(cart.get());
      this.off = cart.subscribe(draw);
    },
  });

  define('floreo-checkout', {
    render: function () {
      var back = returning();
      if (back) return this.showOrder(back.number, back.token, back);
      checkoutView(this.mount, {});
    },
    refresh: function () { checkoutView(this.mount, {}); },
    showOrder: function (number, token, opts) { this.off = orderView(this.mount, number, token, opts); },
  });

  // ---------- coming back from the payment page ----------

  var back = null;
  var backRead = false;
  /** The order this page was opened for (floreo_order in its address), read once and taken out of the address. */
  function returning() {
    if (backRead) return back;
    backRead = true;
    var q = new URLSearchParams(location.search);
    var number = q.get('floreo_order');
    if (!number || !/^\d{1,9}$/.test(number)) return null;
    back = { number: number, token: q.get('floreo_token') || '', paymentId: q.get('floreo_payment') || undefined, cancelled: q.get('floreo_cancelled') === '1' };
    try { history.replaceState(history.state, '', pageUrl()); } catch (e) { /* a file page */ }
    return back;
  }

  function start() {
    var r = returning();
    // No checkout of its own on this page: the order opens over it.
    if (r && !document.querySelector('floreo-checkout')) overlay().openOrder(r.number, r.token, r);
    // Without a cart button on the page, one appears once there is something in the cart.
    var floating = null;
    var sync = function (c) {
      if (conf.cart === 'none' || setupProblem()) return;
      if (c.count > 0 && !floating && !document.querySelector('floreo-cart')) {
        floating = document.createElement('floreo-cart');
        floating.setAttribute('floating', '');
        document.body.appendChild(floating);
      }
      if (floating) floating.hidden = c.count === 0;
    };
    cart.subscribe(sync);
    sync(cart.get());
    emit('ready', { store: conf.store, test: testKey });
  }

  window.Floreo = {
    version: VERSION,
    store: conf.store,
    test: testKey,
    api: client,
    cart: cart,
    checkout: { open: startCheckout },
    product: { open: function (handle) { overlay().openProduct(handle); } },
    order: { open: function (number, token) { overlay().openOrder(number, token); } },
    /** Floreo.on('cart' | 'order' | 'paid' | 'error' | 'ready', fn): fn gets the event's detail. Returns a function that stops listening. */
    on: function (name, fn) {
      var listener = function (e) { fn(e.detail); };
      window.addEventListener('floreo:' + name, listener);
      return function () { window.removeEventListener('floreo:' + name, listener); };
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
