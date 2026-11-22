# Running eInvoicing in production

This is the runbook for the team that operates the service: how it is deployed,
what to watch, how to back it up and recover, how keys are handled, and what to
do when something goes wrong.

## 1. What runs

| Piece | What it does | Where |
|---|---|---|
| App server | API, web app, storefronts, platform console | `Dockerfile`, `src/server.ts` |
| Background worker | Retries documents waiting for BTS, sends the contingency queue | inside the app server (`WORKER_INTERVAL_MS`) |
| Housekeeping | Recurring invoices, notification emails, payment reminders to businesses' customers, operations alerts, clean-up | inside the app server (`HOUSEKEEPING_INTERVAL_MS`) |
| PostgreSQL 16 | Everything, including the signed XML (the legal record) | managed service recommended |
| Object storage + CDN | Product photos (optional) | S3, R2, Spaces, MinIO |
| SMTP | Password links, documents, notices | any provider |

Settings are environment variables; `deploy/env.example` lists them all with
comments. A single machine can run `deploy/docker-compose.prod.yml`.

### Scaling out

The app servers are stateless: sessions, rate limits, sign-in challenges and
notification bookkeeping are all in PostgreSQL, so any number can run behind a
load balancer. Run the worker and housekeeping in **one** of them (set
`WORKER_INTERVAL_MS=0` and `HOUSEKEEPING_INTERVAL_MS=0` on the others). Running
them twice is safe, only wasteful.

## 2. Monitoring

* **`GET /health`**: `200 {"status":"ok"|"degraded","worker":"ok"|"stale"}` while the
  database answers, `503` when it does not. Point the load balancer here.
* **`GET /metrics`** (Prometheus; set `METRICS_TOKEN`, scrape with
  `Authorization: Bearer <token>`): worker heartbeat age, documents pending /
  stuck / in contingency, open outages, certificates expiring or expired, HTTP
  requests and 5xx per process.
* **Alerts** (`ALERT_WEBHOOK_URL`, Slack/Teams/Discord-style JSON): a message
  when a problem starts and another when it is resolved:

| Alert | Meaning | First thing to check |
|---|---|---|
| `worker_stale` | No worker heartbeat for 5 minutes | Is the process that runs the worker up? Its logs (`worker failure`) |
| `documents_stuck` | Documents pending with BTS for 15+ minutes | BTS status; app logs for that business; the business's certificate |
| `contingency_queue` | 500+ contingency documents waiting | BTS outage length; worker logs |
| `certificates_expired` | A business's certificate has expired | The business was emailed at 30/14/7/1 days; contact them |

Businesses get their own emails (owners and admins) when BTS rejects a
document, when an outage starts and ends, and before their certificate expires.

Suggested external checks: an uptime monitor on `/health` from outside the
network, and disk/CPU alerts from the host or cloud provider.

## 3. Backups and recovery

**Targets:** lose at most 5 minutes of data (RPO), be back within 2 hours (RTO).

1. **Managed PostgreSQL with point-in-time recovery** (AWS RDS, Google Cloud SQL,
   Azure, DigitalOcean, Neon...) is the main protection: it restores to any
   minute within the retention window. Keep at least 14 days.
2. **Nightly logical dumps** as a second, independent copy:
   `npm run backup` (`scripts/backup.sh`): compressed `pg_dump`, checksum, 14
   days kept locally, copied off-site with `BACKUP_S3_URI`. The production
   compose file runs it every night at 03:00 Belize time.
3. **The key-encryption key** is backed up separately, never with the dumps:
   in the team password manager or the key service. A dump without the key
   still has every document; only the certificates' private keys are lost
   (each business would re-install its certificate).
4. **Photos** in object storage: enable versioning on the bucket.

### Recovery

1. Create a new, empty database.
2. Restore: managed PITR to a timestamp, or
   `DATABASE_URL=<new db> npm run restore -- backups/einvoicing-<stamp>.dump`.
3. Start one app server against it with the same `KEY_ENCRYPTION_KEY` and
   `WORKER_INTERVAL_MS=0`. Sign in to a business, open a document's PDF (this
   proves the signed XML), and check the platform console.
4. Switch `DATABASE_URL` everywhere, restart, then set the worker back on in
   one process. Documents that were pending are retried automatically.

**Restore drill:** once a month, restore last night's dump into a scratch
database and run step 3. Write down how long it took.

## 4. Keys

* `KEY_ENCRYPTION_KEY` (32 bytes, Base64) encrypts every business's certificate
  private key and every two-step sign-in secret (AES-256-GCM, bound to its row).
  Each stored value names the key that encrypted it.
* **Rotation** (yearly, and at once if the key may have leaked or someone who
  had it leaves):
  1. `openssl rand -base64 32`, store it in the password manager / key service.
  2. On every server: `KEY_ENCRYPTION_KEY=<new>`, `KEY_ENCRYPTION_KEYS_PREVIOUS=<old>`; restart.
  3. `npm run rotate-keys` (`-- --dry-run` first to see the counts).
  4. Remove `KEY_ENCRYPTION_KEYS_PREVIOUS` everywhere; restart. Keep the old key
     until the oldest backup that needs it has expired.
* **Key service:** the code talks to keys only through `KeyProtector`
  (`src/db/keystore.ts`, `encrypt`/`decrypt`, async). To move to AWS KMS, Google
  Cloud KMS or Azure Key Vault, implement those two methods with the service's
  encrypt/decrypt (or envelope encryption with a data key), keep the
  `v2:<key id>:` prefix scheme, and run `npm run rotate-keys` with the new
  protector to move existing values. The key then never leaves the service.
* Other secrets (`SMTP_URL`, `S3_SECRET_ACCESS_KEY`, `METRICS_TOKEN`) belong in
  the platform's secret store, not in files on the machine.

## 5. Product photos

Without `S3_*` settings photos stay in the database (fine for small
deployments). To move to object storage behind a CDN:

1. Create a bucket (private is fine) and a CDN in front of it, e.g. Cloudflare R2
   with a public custom domain, or S3 + CloudFront.
2. Set `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY` and `S3_PUBLIC_URL` (the CDN address); restart. New
   photos go to the bucket; buyers' browsers are redirected to the CDN.
3. `npm run move-photos` moves the existing ones (safe to stop and re-run).

## 6. Store domains, payments, integrations

- **Store domains.** Businesses point a CNAME at `STORE_DOMAIN_TARGET` and verify with a TXT record. Serve that host through a proxy with on-demand TLS, asking the app before issuing a certificate. With Caddy:

  ```
  { on_demand_tls { ask http://app:3000/v1/domains/check } }
  https:// { tls { on_demand }  reverse_proxy app:3000 }
  ```

- **PayPal.** Each business connects its own PayPal app (client id and secret, encrypted at rest). Nothing to set up on the platform. Pending payments are reconciled every housekeeping run.
- **Belize Bank cards.** Each business connects its own merchant login for the bank's card payment page (sandbox or live); nothing to set up on the platform. The bank calls `<PUBLIC_URL>/v1/payment-callbacks/belizebank` when something happens to a payment; the callback only prompts a status check with the bank.
- **E-Kyash.** Set `EKYASH_SANDBOX_URL` and `EKYASH_LIVE_URL` to the API addresses Belize Bank gives (the same for every merchant). Each business enters its merchant id, PIN hash, API key and API password, and gives the bank `<PUBLIC_URL>/v1/payment-callbacks/ekyash/<slug>` for notifications (signed with the API password).
- **Belize Bank bill payments.** A business turns them on in Getting paid → Reminders and paying, and gives the bank the three addresses (`/v1/billpay/<slug>/validate`, `/post`, `/reconcile`) and the token shown once. The bank's requests must reach the app over HTTPS within 30 seconds; a firewall rule that only lets the bank's network reach `/v1/billpay/` is recommended.
- **QuickBooks Online.** Create one app at developer.intuit.com, set `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT=production` and register `<PUBLIC_URL>/v1/integrations/quickbooks/callback`. Syncs run every minute from the worker's process; failures retry with backoff and are listed in each business's Settings → Integrations.
- **Payment reminders** are emailed by housekeeping for businesses that turned them on (at most 50 per business per run, each step once per invoice). They need SMTP and `PUBLIC_URL` (for the pay links).
- **Webhooks** go out every 5 seconds from the worker's process. A failing endpoint is switched off after 20 failures in a row; the business switches it back on.

## 7. Staff accounts

Staff sign in to `/admin` with two-step sign-in, always: the first sign-in sets
up the authenticator app and shows ten recovery codes. Manage staff from the
command line: `npm run platform-admin -- add|reset|reset-2fa|disable|enable|list`.
A lost phone: `reset-2fa` (they set it up again at the next sign-in).

## 8. When something goes wrong

**BTS is down.** Nothing to do: businesses keep issuing in contingency mode
(documents say "Pending of BTS authorization"), owners are emailed, and the
worker sends the queue when BTS answers. Watch `contingency_queue`.

**Worker stopped** (`worker_stale`). Restart the process that runs it. Pending
and contingency documents are picked up where they were.

**A business cannot issue: certificate expired.** They install the renewed
certificate in Settings → Business. Nothing is lost; documents that failed to
sign were never numbered.

**The key-encryption key is lost.** Documents, reports and archives are
unaffected. Every business must install its certificate again; set a new key
first, then contact them. Two-step sign-in secrets are lost too: reset them
(`platform-admin reset-2fa` for staff; owners reset their users in Settings →
Users, and an owner without access needs `delete from two_factor where owner_id = ...`
done by an operator after verifying their identity).

**The key may have leaked.** Rotate it now (section 4), then ask the affected
businesses to request new certificates from BTS and revoke the old ones.

**Data was changed by mistake.** Issued documents and audit events cannot be
changed or deleted (database triggers). For anything else, restore to a scratch
database at a time before the change and copy the rows back.
