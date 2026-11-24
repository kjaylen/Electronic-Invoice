# Decisions

Judgment calls made while working through PLAN.md, changes I chose not to
make, and things I could not resolve. Newest at the bottom of each part.

## How the work was done

- **The brief's blanks.** The request had unfilled placeholders (who the
  customers are, what is weak, must-haves). I filled them from what the
  project already says: owners of small Belizean businesses, not technical,
  often on a phone, making their online store's site. No must-haves of my own
  were added beyond the brief's list; custom domains, a contact form and
  payments already exist and were left as they are.
- **A branch, not `main`.** The site builder was committed to `main` (by
  another session) while I was reading it, and another chat's dev server was
  running in this folder. All of this work is on `site-builder-flagship`,
  branched from that commit. Nothing was pushed.
- **A server of my own.** `node e2e/view.ts` serves the browser tests' database
  on port 3110 so I could use the app without touching the demo data or the
  other chat's server; `E2E_VIEW=1` reruns tests against it. Both are small
  additions to the test tooling, kept because they made every later check
  quicker.
- **Commits.** One concern per commit where files allowed it. Where two
  concerns touched the same lines of the same file (the editor's rewrite for
  saving and for page addresses; translations and styles shared by a group)
  they went in together rather than being split by hand.

## Choices that could have gone another way

- **Two people editing: refuse, then ask.** A draft save now says which draft
  it was made on top of; the server refuses it if someone else saved since
  (409 `draft_changed`). The alternative, merging, is not safe for a document
  of sections. The check uses the existing `draft_updated_at` column; no
  schema change. Saves that send no `base` behave exactly as before.
- **A page is never dropped for its address.** The server used to remove a
  page whose address was invalid or already taken. It now repairs the address
  (from the title, numbered when taken). Safer for data; the one behaviour
  that changes is that a duplicate is kept under `name-2` instead of vanishing.
- **Unsaved work is kept in the browser's storage.** Only on the device, only
  until it is saved, and it is offered back rather than applied by itself, so
  a stale copy can never silently replace newer work.
- **Starting sites replace the home page, menu, footer and look, and keep
  everything else** (logo, tab icon, social links, search text, the pages
  already made, the Templates home section). Applying one is a single undo
  step and nothing reaches customers until Publish. Their wording is English
  (the store's content, not the app's interface); the names and descriptions
  shown in the editor are translated.
- **New pages default to "Blank page".** Defaulting to a template risked
  someone typing "Shipping" and getting an About page.
- **Saved sections live inside the site document** (`saved`, at most twenty),
  not in a table of their own, so there is no schema change. They are stripped
  from what customers are sent. A saved section is added as a copy: changing
  one page does not change another. Truly linked ("change once, changes
  everywhere") sections were not built; see below.
- **Typing in the preview is limited to short plain texts** (headlines, texts,
  button labels, block titles). Formatted text (bold, lists, links) and
  questions inside fold-out answers are still edited in the panel: editing
  formatted text in place needs a proper rich-text editor, which is a heavy
  dependency the ground rules exclude.
- **Pictures are resized in the browser, not on the server.** No new
  dependency, works on a slow connection (the small file is what uploads), and
  the server's limits are unchanged as a backstop. Applied to the site
  library, product photos and Templates.
- **Missing pages now answer 404.** `/shop/products/x`, `/shop/pages/x` and
  `/shop/collections/x` for something that does not exist used to answer 200
  with the app (which then said "not available"). They now answer 404 with the
  same app, and carry `noindex`, as do the cart, checkout and order pages.
  Addresses themselves are unchanged. One existing test asserted the old 200
  and was updated.
- **Gallery and logo pictures have no description field.** They are lists of
  picture references, and a description per picture needs a change to how the
  list is stored. They stay decorative (empty alt). Banner, picture with text,
  columns and visit us have one.

- **The plan and its invoices need `business.manage` to read.** The app only
  ever showed them to owners and admins; the API let any signed-in member of
  staff read them. This narrows an API answer for cashiers, managers and
  accountants (403 instead of the data). API keys keep access. What a plan
  allows (in `/v1/me`) is unchanged, so nothing in the app changes for them.
- **Compression is done at build time by a small script, not a server plugin.**
  `npm run web:compress` writes Brotli and gzip copies beside the built files
  and the server sends them as they are. No new dependency, nothing compressed
  per request, and it does not rely on how the proxy in front is set up. It is
  a separate step from `web:build` (the Docker image runs both) so the tills'
  app bundles are not padded with compressed copies.
- **The storefront does not ask who is signed in.** The staff session is only
  asked for when a staff page is opened. Moving from a store page to a staff
  page inside the app (nothing links that way today) asks at that point.
- **On phones the store's language switch is in the footer.** With a logo,
  search, sign-in and the cart there is no room for it in the header.

## Worth doing, deliberately not done

- **Server-side picture variants (several widths, modern formats).** Would
  make stores faster again, especially product grids. Needs an image library
  on the server (a heavy dependency) or a resizing proxy in front of it.
- **Linked sections** (one section shown on many pages, edited once). Needs a
  place to keep them and a reference type in the page document; better as a
  designed feature than a patch.
- **Touch drag and drop.** Dragging uses the browser's own drag events, which
  do not fire on touch screens; the arrow buttons work there. A pointer-based
  drag is a contained piece of work.
- **Publishing as one transaction.** `publishSite` writes the published site,
  then the version, then prunes old versions, as three statements. A failure
  between them leaves a published site without its history entry. Low risk,
  but worth wrapping.

- **The store's details are rebuilt on every page view.** `GET /v1/store/:slug`
  loads the store, its plan, the published site (checked again each time) and
  renders the business's Liquid templates and custom code. Fine at today's
  size; a short per-store cache, dropped on publish and on saving settings or
  templates, is the next step when traffic grows. Not done now because a
  stale cache on a store is worse than a slow one, and it needs care.
- **A product's photos can only be added after its first save.** One more
  step on the way to a first product. Changing it means creating the product
  as a draft behind the scenes, which touches the product flow more than a
  polish pass should.
- **A visitor's sign-in page logs one failed request** (asking who is signed
  in answers 401 when nobody is). Harmless and expected; changing the answer
  would change the auth flow, which the ground rules keep as it is.
- **What I could not judge by eye.** The browser pane was hidden for this
  session, so screenshots caught pages mid-transition. The site builder, the
  starting-site dialog and the phone layouts were checked from screenshots;
  the other pages were checked by the sweep and by reading their text, not
  by looking at their spacing and colour. A visual pass by a person is still
  worth doing.

## Blockers

None that stopped an item. Two things to know: nothing was pushed (the work
is local, on `site-builder-flagship`), and GitHub Actions has not run on it.

---

# Connect your own site (24 Nov 2026)

Judgment calls made while working through the second PLAN.md (a site built
outside Floreo, connected to it for the catalogue, cart, checkout, payments
and receipts). The part above this line is the earlier job's and is unchanged.

## How the work was done

- **The brief's blanks.** The brief's bracketed blanks were unfilled, so they
  were filled from the project. The customers: small businesses in Belize and
  the developers and agencies who build their sites. "Frameworks customers
  use" was taken as **plain HTML and JavaScript first, React second**: the
  embed and the first worked example need no build step at all, and React
  gets one worked example. No other framework was targeted.
- **A branch, not `main`.** Everything is on `connect-your-site`, cut from
  `ac3fc5f`. Nothing was pushed, and GitHub Actions was not relied on: the
  checks were run here.
- **A server and a web build of my own.** The demo on port 4300 serves
  `web/dist`, so `web/dist` was never rebuilt. The web app was built into a
  scratch folder and served with `WEB_ROOT` by a private copy of the demo
  server (its own database `einvoicing_integ`, port 3130) and by the browser
  tests. **`web/dist` in the working tree is therefore the old build**: run
  `npm run web:build` and restart the demo to see the new dashboard and
  `/embed.js` there.
- **Acting as a customer first.** Before changing anything, a business was
  signed up on the private server and a static site on another origin called
  the API as the README described. The first `fetch` failed: the store API
  sent no CORS headers, so no browser on another site could use it at all.
  PLAN.md lists the thirteen things found; the plan is ranked from them.
- **Commits.** One concern each where files allowed it. The first commit
  (keys, which sites may call, the answers a site needs, coming back after
  paying) is one because each part is useless without the others and they
  share the same lines of `storefront.ts` and one test file.

## Choices that could have gone another way

- **Publishable keys live in the store's settings, not in a table.** The
  rules forbid schema changes. A publishable key is not a secret, the store
  is loaded by its name on every store request anyway, and the settings
  column is JSON, so `store_settings.connect.keys` needs no migration and no
  extra query. The price: a key cannot be looked up without the store's name
  (it is always in the address), and there is no index over keys. The keys
  are saved with `jsonb_set`, and Settings' own save now keeps whatever keys
  are stored, so neither can overwrite the other.
- **A key is required from browsers on other sites only.** Requests with no
  `Origin` (servers, curl) and pages of the app itself work exactly as before
  with no key: that is what existing integrations and the hosted store do.
  The origin rule is a browser rule; outside a browser an `Origin` can be
  made up, but the store API is public by design (it is what buyers see).
- **The browser's preflight is answered yes for any site, and refusals echo
  the `Origin`.** Stricter would be to answer neither, but then a developer
  sees only "blocked by CORS policy" and cannot tell a missing key from an
  unlisted site. The request itself is what gets checked, a refusal carries
  only its reason, and credentials are never allowed, so nothing but the
  reason reaches a site that is not on the list.
- **A test key works from `localhost` and from a file opened from disk
  (`Origin: null`), with no list.** That is what makes a first page work in
  minutes. It is safe because a test store moves no money and its documents
  have no fiscal value. A live key works only from its listed https sites.
- **Test and live are the business's own state, not a mode per request.** A
  business is in the BTS test environment or in production as a whole. Keys
  are named for the one they were made in and refused in the other, so a
  test key stops the moment the store goes live (with the reason). A sandbox
  after going live is a second business that stays in test mode. Test data
  inside a live business would need the schema changed (see below).
- **The embed is one hand-written file, `web/public/embed.js`** (60 kB as
  written, 15 kB with Brotli), like `sw.js` beside it: no build step, no
  dependency, readable by the people who load it. Custom elements with
  shadow roots, so a site's CSS cannot break it and it cannot break the
  site; the site styles it through CSS variables and `::part`.
- **The checkout runs inside the embed, on the site's own page**, not in a
  frame or on the hosted store, so it takes the site's look. Paying online
  still happens on the provider's page, as it must.
- **Coming back after paying puts the order's token in the site's address**
  (`floreo_token`), as the hosted order link already does (`?t=`). The embed
  takes it out of the address at once. `returnUrl` is only accepted with a
  publishable key and only for a page on one of that key's sites.
- **Buyer accounts stay on the hosted pages.** They sign in with a cookie of
  the app, which another site can neither send nor read, and the auth flow
  is to be left as it is. From another site the account routes answer
  `hosted_only` and point at the hosted account page; the embed's checkout
  is a guest checkout.
- **Error messages changed their words, for every route.** The shape
  (`{ error: { code, message, details } }`), the codes and the statuses are
  the same; `message` for a request that does not fit used to be the
  validator's sentence and now names the field in plain words, and `details`
  still carries the validator's findings. A program that matched on the old
  sentence would notice; nothing in the app or its tests did.
- **Unknown addresses under `/v1` say more.** "Route not found" became
  "There is no GET /v1/... in this API"; the code and status are unchanged.
- **`/v1/orders` without `limit` still answers the newest 300.** `limit` and
  `cursor` are new and optional; `nextCursor` is an added field.
- **Store orders reuse the documents' idempotency table** under a scope
  (`store-order:<key>`), with the answer sealed by the key ring because it
  carries the buyer's link token, and swept after two days.
- **New webhook events are written by the code, not by triggers.** A trigger
  is a schema change. So `product.*`, `stock.changed` and
  `order.payment_failed` are raised where the change is made (in the same
  transaction when there is one); a change made straight in the database
  would not raise them, unlike the older events. `stock.changed` fires on
  every change of a tracked item's level, counter sales included; several in
  one run for one item are one delivery. Endpoints subscribed to "all events,
  including ones added later" now get these too, as that choice says.
- **A test delivery of an event sends a sample, marked `"test": true`**, not a
  real past event: it works before anything real has happened and cannot be
  mistaken for one. The test's answer gained `deliveryId` (an added field).
- **The request log is in the server's memory; the counts are in the
  rate-limit table.** See "A durable request log" below. Counts are exactly
  what that table holds (a key, a count, a window), so usage by day, key,
  endpoint and error code is durable and shared by every server process. The
  list of latest requests is per process and lost on restart; the page says
  since when.
- **Limits.** 300 requests a minute per publishable key per visitor; a
  server that sends the key (no `Origin`) is not counted as a visitor, as a
  server with no key never was.
- **`/docs` reference groups got ids of their own (`#api-documents`).** Two
  sections shared the id `webhooks` (the guide and the group). Links from the
  app go to the guides; an old bookmark to a group (`/docs#documents`) now
  opens the page at its top.
- **All new interface text is in English and Spanish**, the docs' guides
  included. The embed carries its own small Spanish dictionary, since it runs
  on other people's pages and cannot load the app's.

## Worth doing, deliberately not done

Each of these needs something the ground rules keep as it is (the schema,
pricing, the auth flow, the payment setup), or is a piece of work of its own.

- **A durable request log.** One table would let the latest requests survive
  a restart and be the same on every server process:
  `api_requests (id bigint identity, tenant_id uuid, key_kind text, key_id
  text, at timestamptz, method text, route text, path text, status int, code
  text, message text, ms int, origin text)`, indexed on `(tenant_id, id
  desc)`, pruned after a week by housekeeping. `src/api/devlog.ts` already
  builds exactly these rows; only `record` and `recent` would change.
- **Scoped secret keys.** A secret key acts as the whole business. Read-only
  keys, keys for one area (orders, products), an expiry date and a test/live
  mark all need columns on `api_keys`.
- **Per-attempt history of a webhook delivery.** Only the last attempt's
  answer is kept (`webhook_deliveries` has one answer per row); showing each
  try needs a table.
- **Test data inside a live business.** A real test mode beside live data
  (as payment providers have) means an environment on orders, products and
  keys. Today the sandbox is the business being in test mode, or a second
  business.
- **Webhooks while trying things out.** Webhooks are on the Pro plan, and a
  new business's trial is the Business plan, so a developer cannot try a
  webhook during the trial at all. Allowing webhooks while a business is in
  test mode would fix the first integration without giving anything away.
  It is a pricing rule, so it was left alone.
- **Webhooks to a developer's own computer.** Endpoints must be public https
  (the server can allow private ones, for tests only, and nothing in the
  environment turns that on). The docs say to use a tunnel. A small
  forwarder ("listen and replay to localhost") would be the real answer.
- **Buyer accounts from another site.** Needs sessions that are not cookies
  (a token the site holds), which is a change to the auth flow.
- **Checkout reminders and "email me when it is back" from the embed.** The
  endpoints exist and are in the reference; the embed does not call them. A
  reminder's link opens the cart on the hosted store, not on the site it was
  left on, which wants a decision of its own.
- **Search and category filters as components**, and a minified build of the
  embed. The grid takes `search` and `category` as attributes; there is no
  search box of its own.
- **A package for developers** (`npm install`, TypeScript types, React
  components). The React example is a small client and an app to copy.
- **Old idempotency rows of documents are never deleted** (they were not
  before either); only the store orders' are swept.
- **Paging by time can skip a row made in the same millisecond as the last
  one of a page.** The cursor keeps milliseconds and the database
  microseconds. This is how documents and customers already paged; orders
  now page the same way.

## Found, not fixed

- **The embed and the docs were checked in Edge (the browser tests' browser)
  and in the app's built-in browser pane.** Not in Safari or Firefox, and not
  on a real phone. Everything used is long standard (custom elements, shadow
  roots, `<dialog>`, `fetch`), but it was not run there.
- **Real payment providers were not run** (the rule is test mode only).
  `returnUrl` goes to Belize Bank, E-Kyash and PayPal through the same code
  path that carried the hosted return address, and the test gateway was run
  end to end; whether a provider restricts return addresses on its side for
  a given merchant account was not checked.
- **The built-in browser pane logs "An unknown error occurred when fetching
  the script" on every page of the app**, old pages included. It looks like
  the service worker's registration in that pane; the browser tests (Edge)
  load the same pages with a clean console. Not looked into further.
- **Screenshots in the built-in pane were taken while it was hidden**, which
  pauses animations, so dialogs looked half faded. Layout was judged from
  those and from reading the pages' text and computed styles; a look by a
  person at the embed's cart, checkout and the dashboard's logs is still
  worth having.

## Blockers

None that stopped an item. Nothing was pushed (the work is local, on
`connect-your-site`), and GitHub Actions has not run on it.

---

# The request-log table and scoped secret keys (24 Nov 2026, afterwards)

The ground rule against schema changes held back two things, written up above
under "Worth doing, deliberately not done". The go-ahead for both was given
after the summary, so they were built on the same branch. What was written
above is left as it was written; this part says what is true now.

- **Two migrations, numbered 055 and 056.** The branch `offline-first-tills`
  already has an unmerged `054_offline_tills.sql`. The migration runner
  applies any file it has not seen, by name, so the branches merge in either
  order; 054 is left for the branch that owns it.
- **The log is written in batches, a second later at most.** One insert per
  request would put a write on every product view from an embedded store.
  Rows wait in the process and go together (at once when a hundred wait); a
  crash loses the last second of log at most, and a database that is away
  loses what waited rather than holding requests up or piling rows in memory.
  Reading the log writes this process's waiting rows first, so a request
  just made is in the answer.
- **A week, and the newest 10,000 per business.** Both numbers are mine. A
  week is long enough to look into "it failed on Monday"; the cap keeps one
  busy or broken integration from growing the table without limit. The 35
  days of counts (by day, key, endpoint and error) are separate and unchanged.
- **`since` became `keptDays`** in `GET /v1/developer/requests`, and the
  answer gained `nextCursor`. The endpoint was added on this unmerged branch,
  so nothing outside it read `since`.
- **A row for a business erased meanwhile is left out of the batch** rather
  than failing it, so one closed business cannot lose the others' rows. The
  erase itself needed no change: it walks the database's foreign keys.
- **Scopes are checked by the route's address, in one place, not by adding
  checks to routes.** Many of the API's routes that only read have no permission check
  of their own (anyone signed in may read), so narrowing the permission table
  could not make a key read-only. The check runs where a key is recognized;
  full keys skip it entirely.
- **A route with no area stops the server from starting.** That is how a
  route added later cannot end up outside the scopes: the first test run (or
  the first start) says which line to add. `people` marks what keys never
  reach (users, keys, the logs).
- **Eight areas, following how the app is laid out**, not one per endpoint
  group: documents, customers, catalogue, orders, reports, expenses, webhooks,
  business. Finer ones can be split out later without changing existing keys
  (a key's areas are a list of names).
- **Reading means GET, plus four POSTs that change nothing** (a document's,
  a collection's and a template's preview, checking a gift card's code).
  Dry runs that are a flag in the body (imports, repricing) are not let
  through for a read-only key: the body is not looked at.
- **`GET /v1/me` always answers for a limited key**, and says what the key
  may do (`apiKey`), so a program can find out why it is refused.
- **A key keeps the limits it was made with.** Changing a live key's reach in
  place is how an integration breaks at an unknown moment; making another
  key and revoking the old one is the same rotation as before. Replace in the
  dashboard copies the limits (an end date only while it is still ahead).
- **An expired key says that it expired, and names itself**, but only to a
  caller that presented its whole secret. A wrong secret is still just
  "invalid key".
- **Not included: a test or live mark in the secret key's own text**
  (`etd_test_…`). The dashboard shows which the business is, and changing
  the key's form risks integrations that check it.

Still held back, for the same reason as before: a history of every attempt of
a webhook delivery (a table), and test data inside a live business.

Checked the same way as before: the web app built into a scratch folder and
served with `WEB_ROOT`, so the demo's `web/dist` is still the old build.

---

# Email: settings, one mail service, a queue, a log (24 Nov 2026)

Judgment calls made while working through the third PLAN.md (the SMTP email
system). The parts above this line are the earlier jobs' and are unchanged.

## How the work was done

- **The brief's blanks.** The request had unfilled placeholders. What exists
  was read from the code (one module, `SMTP_URL`, no queue). The server is "any
  standard SMTP server". The emails are the 27 found in the code, listed in
  PLAN.md. The numbers are the brief's own defaults: 5 attempts, 90 days. No
  must-haves of my own were added: attachments, two languages and editable
  templates already existed and were kept.
- **A folder of its own.** Another session had uncommitted work in the main
  folder, so this was done in a git worktree, `../eInvoicing-email`, on the
  branch `email-system`. It was cut from `connect-your-site` (not `main`),
  because that branch changes the same settings pages and was about to be
  merged; its three later commits were merged in on the way. Merging
  `email-system` therefore brings `connect-your-site` with it. Nothing was pushed.
- **Migration 057.** 054 is taken by the offline-tills branch and 055 and 056
  by `connect-your-site`. Migrations are applied by name, so the gap is harmless.
- **A database and ports of their own for the browser tests**
  (`E2E_DATABASE_NAME`, `E2E_PORT`, `E2E_MAIL_PORT`), so two sessions can run
  them at once. The defaults are what they were.
- **Commits.** The foundation (the service, the queue, settings, SMTP, the
  routes) went in as one commit: its parts do not compile without each other.
  After it, each group of emails was moved in a commit of its own, with the
  tests that cover it run first.

## Choices that could have gone another way

- **The queue and the log are one table** (`mail_messages`). A message is a
  row from the moment it is queued to the day the log forgets it. One table
  means the log can never disagree with the queue.
- **`send()` means "safely queued", not "delivered".** Callers that said
  "Emailed to X" still do; what happened next is in the log. A caller is only
  told of a failure when the message could not be queued at all (no mail
  server, a bad address). The alternative, waiting for the server's answer, is
  exactly what made a slow mail server hold up a checkout.
- **Who an email is from is decided by its type, not by the caller**
  (`src/mail/types.ts`). Emails to a business's customers and suppliers are
  from the business. Sign-in links, invitations, notices, billing and the
  store's contact form are from the platform, even when they are about one
  business: a business's broken mail server must never be the reason its owner
  cannot reset a password.
- **Falling back is immediate.** When a business's server fails for a reason
  that is the server's (sign-in, connection, encryption, the from address, a
  quota), the same attempt goes on to the platform's server. The customer gets
  the invoice now, from the platform's address with the business's name, and
  the business sees why on its settings page. After three failures in a row
  its server is left alone for 15 minutes and it is emailed once. A mailbox
  that does not exist does not fall back: the platform would be told the same.
- **A business's own server must be a public address on port 25, 465, 587 or
  2525.** Otherwise the settings form and its test button would let anyone
  with a business account make the server connect to machines inside the
  platform's own network. The name is resolved once and the connection goes to
  that very address. `MAIL_ALLOW_PRIVATE_HOSTS=true` lifts this for development.
  The platform's own server is the operator's choice and is not restricted.
- **"None" is offered as an encryption, with a warning**, because the brief
  asks for it and a relay on the same machine needs it. It is not refused for
  a business; the form says the password would travel unprotected.
- **What a message carries is encrypted at rest**, with the key that protects
  certificates, bound to the message's id. Without this the log would hold,
  in plain text, the password-reset links that the database otherwise only
  keeps hashed.
- **Messages that hold a secret are scrubbed once delivered** (password
  resets, invitations, sign-in codes, gift cards, account links) and cannot be
  resent: send a new one instead. They are also not sent after the link or
  code in them has stopped working.
- **The log is kept 90 days, message bodies 30.** Bodies carry PDF
  attachments; ninety days of them for every business would be most of the
  database. "Send again" works while the body is kept.
- **Over the rate limit means waiting, not refusing.** A business may send
  300 emails an hour and 2,000 a day; more stay queued until the window
  resets. Refusing would break the action that caused the email. Emails from
  the platform to a business do not count against the business.
- **The do-not-send list is per business.** An address that bounced for one
  business is not blocked for another. Sharing the list would let one
  business's typing mistake stop another's invoices.
- **Only two emails are "not transactional"**: checkout reminders and the
  daily summary. Payment reminders and statements are about money the person
  owes, and "back in stock" is something the buyer asked for once. The mail
  service refuses to queue an optional email without an unsubscribe link, so a
  new one cannot be added without it. Checkout reminders keep their own
  existing link and public address.
- **The unsubscribe page is plain HTML served by the API**
  (`/v1/mail/unsubscribe/<token>`), not a page of the web app, so it works
  without JavaScript and cannot collide with a business's address. Opening it
  changes nothing (mail scanners open links); the button, or a mail app's
  one-click, does.
- **Mail settings and the email log are for signed-in owners and admins, never
  API keys.** A test found a key could read them; they hold who a business
  writes to.
- **`SMTP_URL` keeps working.** It is the platform's server until one is saved
  in the console, read the way it always was (an `smtp://` address still
  carries on when the server offers no STARTTLS). Existing deployments change
  nothing.
- **The customer account link became a template** (`email.account-link`), as
  it was the one customer-facing email still built in code. Its link must stay
  in it.
- **The eleven existing templates were not rewritten onto a shared layout
  file.** They already share one design, and businesses may have saved edited
  copies of them as whole documents. Emails built in code now use one layout
  module that matches that design.
- **Presets are four** (Google, Microsoft 365, Zoho, Amazon SES), as the brief
  lists. Microsoft's note says password sign-in for SMTP is being phased out,
  without a date: the date has moved more than once.

## Worth doing, deliberately not done

- **Sign-up verification.** There is none, and a new business's owner signs
  in at once. Adding it changes the auth flow, which the brief says to leave.
- **OAuth sign-in to a mail server** (XOAUTH2, what Microsoft is moving to).
  Needs an app registration with each provider.
- **Bounces that come back later.** A server that accepts a message and
  bounces it afterwards sends the bounce to the from address as an email.
  Reading those needs an inbox the platform can read, or a provider's bounce
  webhook. Only refusals during sending go on the do-not-send list.
- **DKIM signing by the platform.** Messages are signed by the mail server
  they go through, which is how every listed provider works.
- **Spanish for what the server writes**: the DNS check's explanations and
  some failure texts carry values (a domain, a server's answer) and are in
  English. The screens themselves, field errors, hints and preset notes are
  in both languages.
- **Scheduled and bulk (marketing) email.** Not in the brief's list.

## How it was proved

- **Tests.** 36 new unit tests in `test/mail.test.ts` and
  `test/mail-api.test.ts`, against a real SMTP conversation with a local
  catcher (`test/mail-catcher.ts`): valid and invalid settings, each
  encryption mode and each mismatch, a wrong password, an unreachable server,
  retry then success, retry then failure after five attempts, falling back
  from a business's server to the platform's, the do-not-send list, header
  injection, and all twelve templates with hostile and with missing values.
- **The browser tests send by SMTP.** The demo server they run against now
  delivers through the queue to a catcher, so the existing tests that read an
  email (an invoice, an invitation, a password reset, an order, a sign-in
  code, a gift card) prove the whole road. Two new tests drive Settings →
  Email and the console's Email page.
- **Every type, looked at.** `npm run mail:proof` runs the unit tests with
  their mail mirrored to a catcher and lists one message of each of the 27
  types: all 27 arrived, each with an HTML and a plain-text part, sized for a
  phone, with no unfilled value, and the two optional ones with a way to stop
  them. Seven were opened at desktop and phone width. Three of the 27 are
  sent by background jobs that their tests call without the mail service
  (payment reminders, back-in-stock, checkout reminders), so in that run they
  show a placeholder sender; their real sender is covered by the service's
  own tests.

## Found, not fixed

- **No real mail provider was connected to.** There are no credentials here,
  and the rule is that nothing goes to real people. The presets' servers and
  ports are the ones each provider publishes; the notes on app passwords are
  from their documentation. The first real test is yours: "Send test email"
  in the console.
- **No real mail app was looked at** (Gmail, Outlook, Apple Mail). The emails
  were viewed in a browser at two widths. The layout is tables and inline
  styles, as mail apps need, and is the one the existing templates already used.
- **The deliverability check was not run against a real sending domain.** Its
  logic is tested with made-up DNS answers; the browser test ran it against a
  domain that does not exist.
- **"Emailed to X" is said when the email is queued.** A document's own
  history (`document_messages`) records "sent" at that moment too. If the
  email later fails, the email log says so, the document's history does not.
- **A business with its own mail server on a platform with none.** The mail
  service would send its emails, but the routes that check "is email set up"
  first still answer 503. In practice the platform always has a server.
- **The main folder's demo on port 4300 still runs the code before this
  work.** It was left alone because another session was using that folder.
- **The built-in browser pane was hidden**, so it could not draw screenshots.
  The screens were checked by the browser tests, by reading the pages and
  measuring the layout at 375 px, and the emails by screenshots from a
  headless browser.

## Blockers

None that stopped an item. Nothing was pushed, and GitHub Actions has not run
on this branch.
