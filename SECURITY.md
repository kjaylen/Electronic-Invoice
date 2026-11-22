# Security

## Reporting a vulnerability

Please report security problems privately, not in public issues: use GitHub's
"Report a vulnerability" (Security → Advisories) for this repository, or email
the address set as `CONTACT_EMAIL` on the deployment. Include what you found,
how to reproduce it, and what an attacker could do with it.

We aim to acknowledge reports within 3 working days and to fix serious
problems within 30 days, and we will credit you if you wish. Please give us
reasonable time to fix a problem before disclosing it, do not access data that
is not yours, and do not disrupt the service for others.

## What protects the service

- **Signed documents** are stored exactly as sent to BTS; database triggers stop issued documents, events and the audit log from being changed or deleted.
- **Secrets at rest** (certificate private keys, two-step sign-in secrets, webhook secrets, payment and accounting credentials) are encrypted with AES-256-GCM under a versioned key, bound to their row; keys rotate with `npm run rotate-keys` (docs/operations.md).
- **Accounts**: scrypt password hashes, two-step sign-in (mandatory for platform staff, optional or required by the business for owners and admins), per-business sessions in HttpOnly cookies, CSRF header on every change, roles with least privilege, an activity log.
- **Abuse limits** on sign-in, sign-up, password links, orders, emails and API keys, shared across servers in the database.
- **Webhooks** only reach https URLs that resolve to public addresses (checked on the address actually connected to).
- **Payments**: amounts are confirmed with the provider before an order is marked paid; the test gateway is refused in production.
- **Headers**: a strict content security policy, HSTS, `X-Frame-Options`, `nosniff`, a restrictive permissions policy.
- **Dependencies**: `npm audit` in CI, Dependabot updates, CodeQL analysis.
