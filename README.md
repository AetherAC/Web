# AetherAC website

VitePress website, public roadmap, Blog/News CMS and GitHub progress sync for AetherAC.

## Local development

```powershell
npm install
npm run dev
```

The site works without external services by using local fallback content. Copy `.env.example` to `.env.local` to connect Supabase.

## Routes

- `/` — product landing page
- `/blog` — engineering articles from Supabase
- `/news` — announcements and release notes from Supabase
- `/progress` — CMS roadmap plus live GitHub progress
- `/studio` — authenticated content editor
- `/login`, `/register` — password, email OTP/link and GitHub OAuth
- `/admin` — Fluent 2 CMS, user management, products, payments, repositories, statistics and Vercel environment variables
- `/buy` — authenticated Artifact checkout
- `/me` — account spending and order history
- `/order/{order_id}` — owner-only order detail and refund request
- `/v1/callback/{provider}` — normalized payment callback
- `/api/github-progress` — server-only Vercel Function
- `/api/admin-users` — server-only user management (admin session required)

## Production

See `DEPLOYMENT.md` for the complete Vercel, Cloudflare, Supabase and GitHub configuration.

```powershell
npm run build
npm run preview
```

Static output is generated in `docs/.vitepress/dist`.

## Required database setup

Run `supabase/schema.sql` in the Supabase SQL editor, enable email confirmation and GitHub Auth, then bootstrap the first admin:

```sql
update public.user_profiles
set group_name = 'admin'
where email = 'contact@abnt.it';
```

This one statement is unavoidable: changing `group_name` requires an existing admin under RLS, so the first one cannot be granted from the browser. Everything after it belongs in `/admin` → 用户管理, which lists every `auth.users` row and can change groups, ban or unban accounts, and delete them. Deletion goes through `/api/admin-users` with the service-role key because `auth.users` is out of reach of the anon key, and because `orders.user_id` and `refund_requests.user_id` are `on delete restrict` — an account with transactions is refused until "连带删除" is confirmed, which then clears the refund rows, the order rows and the account's `refund-evidence` objects before the user itself. The endpoint also refuses to touch the caller's own account or the last remaining admin, so the bootstrap problem above cannot be recreated by accident.

The Admin environment editor needs `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID` and, for team-owned projects, `VERCEL_TEAM_ID` to be configured once in Vercel. All remaining runtime and build variables can then be managed in `/admin`; environment changes require a redeployment.

## Linux.DO, LDC and customer-service payments

See [LINUXDO-LDC.md](LINUXDO-LDC.md) for OAuth setup, the additive database installation,
configurable LDC discount/coupon offers, owner-confirmed customer-service payment requests,
message-latency changes, verification steps and safe rollback. The new features default to off.
Offline mocked regression tests: `npm run test:ldc`.

## Existing payment providers

Eight of the eleven providers are pure configuration: `payment_providers.public_config` supplies either a `checkout_url_template` or a `create_url` request whose response is mapped through `checkout_url_path` and `provider_order_id_path`, and their callbacks are authenticated by an HMAC over the JSON body.

Stripe, PayPal and PayerURL cannot be expressed that way, so `public_config.driver` (`"stripe"`, `"paypal"` or `"payerurl"`) switches `/api/checkout` and `/v1/callback/{provider}` to the built-in drivers in `api/_lib/payments.mjs`. Stripe's API only accepts form-encoded bodies; PayPal needs an OAuth2 token before it will create an order, and the buyer's approval only becomes money after a server-side capture; PayerURL signs each request with an HMAC taken over that same request's parameters, which no static configuration can compute.

Stripe's and PayPal's callbacks ignore the request body's claims and re-read the authoritative state from the provider (`GET /v1/checkout/sessions/{id}`, `GET /v2/checkout/orders/{id}`), which is why neither needs a webhook secret: a forged callback costs one extra API read and cannot mark an unpaid order as paid. PayerURL is verified by signature instead — it signs a canonical form of the parameters (top-level keys sorted, values `encodeURIComponent`-encoded with `%20` folded to `+`) rather than the raw bytes, so the signed string can be rebuilt after Vercel has parsed the body, and the merchant's own secret key is the HMAC key in both directions. Its callback signature covers a fixed ten-field whitelist, not the whole body, so a field PayerURL adds later cannot break verification; `status_code` is inside that whitelist, so it is only read after the signature has been checked. Anything not yet settled is left `pending` rather than guessed at, and a callback that reports receiving less than the order's price is refused with `409` rather than releasing the artifact.

PayerURL has no callback setting in its merchant dashboard: `notify_url` travels with each order, which is why the only two credentials it issues are the public and secret keys. The driver is a reimplementation of PayerURL's official Node SDK, published as `binance-crypto-instant-payout-nodejs` (its README calls itself `@payerurl/crypto-checkout`, a name not on the registry). It is not a dependency because that package declares some forty build tools — esbuild, rollup, sucrase, chokidar — as runtime dependencies, all of which would land in the function bundle. Instead `tests/api-smoke.mjs` pins the exact query strings and digests the SDK produces, so drifting from it fails the build rather than a payment.

One thing that SDK is wrong about: its README documents `amount` as "Amount in smallest unit", and its example pairs `amount: 1000` with `price: '10.00'`. The live API reads it as a decimal — a 20.00 USD order sent as `amount: 2000` reaches the checkout page as 2000 USD. Both money fields are decimal strings, and the test asserts that against the measured behaviour rather than the documentation.

| Provider | Secrets | Webhook endpoint | Events |
| --- | --- | --- | --- |
| Stripe | `STRIPE_SECRET_KEY` | `/v1/callback/stripe` | `checkout.session.completed`, `checkout.session.expired` |
| PayPal | `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` | `/v1/callback/paypal` | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` |
| PayerURL | `PAYERURL_PUBLIC_KEY`, `PAYERURL_SECRET_KEY` | `/v1/callback/payerurl` (sent per order as `notify_url`, nothing to register) | settled on `status_code` 200; 20000 is a cancellation, anything else stays pending |

PayPal reads `public_config.environment` (`sandbox` or `live`, falling back to `PAYPAL_ENV`). PayerURL reads `public_config.api_base` when the merchant is on a host other than `https://api-v2.payerurl.com`. All three rows ship with `enabled = false`: add the secrets, redeploy, then tick 对外启用 in `/admin` → 支付平台.
