# Staging

Staging is a full copy of production's setup with its own database, keys and
email, pointed at **BTS's test environment**. Every change goes there first.

## Setting it up

1. A host or container service, its own PostgreSQL, its own bucket (if photos
   use object storage). Nothing shared with production.
2. Settings from `deploy/env.example`, with:
   * `DEPLOY_ENVIRONMENT=staging` (shown in alerts)
   * a different `KEY_ENCRYPTION_KEY`, `METRICS_TOKEN` and database password
   * `PUBLIC_URL=https://staging.example.bz`
   * an SMTP sandbox (Mailtrap, Mailpit, a provider's test mode) so no real
     customer is emailed, or `MAIL_OUTBOX_DIR=/data/outbox` to write emails to files
   * `ALERT_WEBHOOK_URL` to a separate channel
3. Businesses on staging stay in the BTS **test** environment; test documents
   have no fiscal value. Do not move a staging business to production.
4. Protect it: put it behind the proxy's basic auth or an IP allow-list, so
   search engines and strangers do not find it.

## Releasing

1. CI (`.github/workflows/ci.yml`) runs on every push: typecheck, server tests
   (with a real PostgreSQL), the web build, browser tests and the container
   image with a smoke test.
2. Deploy the image to staging. Migrations run when the server starts.
3. Check on staging: sign in to a test business, issue an invoice, a receipt at
   the counter and a credit note; place and pay an online order; download the
   archive for today; sign in to `/admin`.
4. Deploy the same image (same tag) to production.

Migrations only ever add: a release can be rolled back to the previous image
while keeping the newer database. If a migration needs to rewrite data, release
it in two steps (add, then use) so the previous image still works.

## Test data

Use made-up businesses and BTS's test certificates. Never copy production data
to staging; if a production problem needs reproducing, recreate the case by hand.
