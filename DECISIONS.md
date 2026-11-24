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
