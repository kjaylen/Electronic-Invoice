# Plan: the site builder as a flagship, then polish across Floreo

Who this is for: owners of small businesses in Belize, most of them not
technical and many working from a phone, who use Business → Site to make and
keep up their online store (home page, pages such as About and Contact, the
look, menus) without code.

Status marks: `[ ]` to do, `[x]` done, `[-]` skipped (the reason is in DECISIONS.md).

## What exists (read end to end, 23 Nov 2026)

- **Document model** (`src/commerce/site.ts`, `site-schema.ts`): one JSON site
  per store (theme, header, footer, home, product-page sections, own pages),
  twenty section types defined by schema, seven looks, eleven bundled fonts.
  Every save goes through `normalizeSite`. Draft / publish / last 30 versions.
- **Editor** (`web/src/pages/SiteEditor.tsx`, `web/src/site/*`): panel with
  Pages / Theme / Header / Footer / Search tabs, forms built from the schema,
  section list with drag to reorder, undo/redo, autosave after 700 ms, live
  preview (the real storefront in a frame) at three sizes, history dialog.
- **Storefront** (`web/src/pages/Shop.tsx`, `web/src/site/sections.tsx`,
  `theme.ts`): renders the published site; `src/commerce/seo.ts` writes the
  title, description, canonical and Open Graph tags, sitemap and robots.

## What is broken or rough

Found by reading the code and using the builder in the browser.

Losing work:
1. Leaving the editor within 700 ms of an edit drops it: the pending save is
   cancelled on unmount, and nothing warns on closing the tab.
2. A failed save is never retried, the error never clears, and nothing is kept
   on the device to recover from.
3. Saves can overlap (an older request finishing after a newer one), and two
   people (or two tabs) editing overwrite each other silently.
4. A page whose address collides with another's, even for a moment while
   typing it, is **dropped by the server** on the next autosave. A page with a
   bad address is dropped too.
5. The page address box strips a trailing hyphen on every keystroke, so
   "about-us" cannot be typed.
6. Renaming a page's address, or deleting a page, leaves menu links and
   buttons pointing at an address that no longer exists (the delete prompt
   says they go to the home page; they do not).
7. Undo history is written inside a state updater, so React StrictMode (and
   any re-run) records steps twice.
8. The preview can stop following edits: the frame's `load` event can land
   after the storefront says it is ready, and resets the flag.
9. Discard, restore and add-section have no error handling (unhandled
   rejections, no message).

Wasteful or wrong requests:
10. The product picker in a link refetches every 200 ms for as long as there
    is text in it (a new `exclude` array each render).
11. "Ones I pick" refetches the whole product list in a loop when a picked
    product no longer exists.

Slow path from nothing to a site:
12. No starting sites: a new store gets a banner and a product grid, and every
    new page starts empty. Looks change colours and fonts only.
13. Nothing says the store is closed, so an owner can publish and still have
    customers see "not open yet".
14. Pictures over 2 MB (any phone photo) are refused with "make it smaller
    first".

Editing that is less direct than it should be:
15. Text can only be edited in the side panel, never where it shows.
16. Drag and drop only reorders sections, and not on touch screens; blocks and
    menu links move with arrows only.
17. A section cannot be reused on another page.
18. New sections always land at the bottom of the page.
19. Hide/show is an unlabelled dot.

Published sites:
20. Content pictures have no alternative text.
21. No structured data (products, the business) for search engines.
22. The banner picture is a CSS background: no description, not prioritised.
23. Menu drop-downs do not close with Escape; no skip link on the storefront.

## The plan, by customer value

### A. Never lose work
- [x] A1. Saves are queued one at a time, flushed when leaving the editor or
      the tab, retried after a failure, with a clear status and a Retry button.
- [x] A2. A copy of unsaved work is kept on the device and offered back after a
      crash or a failed save.
- [x] A3. Editing in two places: the server refuses a save made on top of a
      draft someone else changed since, and the editor says so and offers to
      load theirs or keep yours.
- [x] A4. Server keeps pages whose address collides or is invalid (gives them a
      free address) instead of dropping them. Tests.
- [x] A5. Page address: can be typed freely, checked on leaving the box, never
      saved as a duplicate; renaming or deleting a page rewrites every link to
      it. Tests.
- [x] A6. Undo/redo recorded outside the state updater; undo works after
      discard and restore; Ctrl+Z covered by a test.
- [x] A7. Preview always follows the editor (ready-flag race), and says so when
      there is no product to preview a product page with.
- [x] A8. Errors from discard, restore, add section and publish are shown and
      cleared on the next success.

### B. From a blank page to a published site, fast
- [x] B1. Starting sites: complete home pages plus About and Contact pages for
      a shop, a food business, a boutique and a service business, with
      Belizean defaults, applied in one click (undoable). Offered first to a
      store that has never published.
- [x] B2. New pages start from a page template (About, Contact, Questions,
      Delivery and returns, Blank).
- [x] B3. The editor says when the store is closed and links to where it is
      opened; Publish explains what customers will see.
- [x] B4. Pictures are resized and compressed in the browser before upload, so
      phone photos just work; drop files onto the library to upload.

### C. Editing that feels direct
- [x] C1. Edit text in the preview: click a headline, text or button in the
      page and type; the panel and the draft follow.
- [x] C2. Fix the two request loops in the product pickers (items 10 and 11).
- [x] C3. Add a section where you are (after the selected one, or from a "+"
      between sections) instead of always at the bottom.
- [x] C4. Saved sections: keep a section to reuse on any page.
- [x] C5. Drag to reorder blocks and menu links; labelled show/hide control.
      (With a mouse. On touch screens the arrows do it; see DECISIONS.md.)

### D. Published sites, good by default
- [x] D1. Alternative text for content pictures (banner, picture with text,
      columns, visit us). Gallery and logos stay decorative; see DECISIONS.md.
- [x] D2. Structured data: Product on product pages, the business on the home
      page. Also: pages that are not there answer 404 and stay out of search.
- [x] D3. Banner picture as a real image (described, loaded first); pictures
      below the fold stay lazy.
- [x] D4. Storefront keyboard and screen-reader basics: skip link, Escape
      closes menus, focus is visible on the themed colours.

### E. The rest of the platform
Worked page by page after A to D. How: a browser test that opens every page
(about seventy, each at a computer's and a phone's width) and fails on an
uncaught error, a logged error, a failed request, a missing heading or
sideways scrolling (`e2e/sweep.spec.ts`); a script over every API route for
permission checks and input schemas; and reading the pages themselves for
copy and states that contradict each other.

- [x] E1. Every page loads cleanly at both widths. Found and fixed: the API
      reference scrolled sideways on phones; the site editor had no page
      heading; on phones the store's logo was squeezed to a dot when the
      search button was on, and the site editor stacked settings over the
      preview (now an Edit / Preview switch).
- [x] E2. States that contradicted each other. Found and fixed: Gift cards
      counted a used-up card as active above "No active gift cards"; Cash
      register said "No shift open" above a shift listed as still open.
- [x] E3. Copy and ways in. Found and fixed: the online store's settings had
      no link to the site builder and described "About" as it worked before
      the builder.
- [x] E4. Security basics. Every tenant route has a permission check (writes
      by permission, reads through shared helpers) except two, now fixed: the
      plan and its invoices could be read by any member of staff. Nearly every
      route has an input schema, and the few without answer malformed input
      with 400 or 404. No secrets in the web source.
- [x] E5. Wasteful requests. Found and fixed: scripts and styles were sent
      uncompressed and re-checked on every page view (now compressed ahead of
      time and cached for a year); every storefront page asked for a staff
      sign-in; the store settings fetched payment accounts four times and the
      overview asked for the orders to handle twice.

Found and left, with reasons, in DECISIONS.md.

### F. Finish
- [x] F1. Full pass: `npm run check` (353 unit tests, none failing) and the
      browser suite on a fresh database: 33 of 34 passed; the one that did not
      was a new phone test tapping the wrong spot, corrected and passed when
      rerun (with the other phone test) on that run's data. The suite was not
      run a further time from scratch after that one-line test change.
- [x] F2. Summary.
