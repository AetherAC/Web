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

## Payments

Nine of the eleven providers are pure configuration: `payment_providers.public_config` supplies either a `checkout_url_template` or a `create_url` request whose response is mapped through `checkout_url_path` and `provider_order_id_path`, and their callbacks are authenticated by an HMAC over the JSON body.

Stripe and PayPal cannot be expressed that way, so `public_config.driver` (`"stripe"` or `"paypal"`) switches `/api/checkout` and `/v1/callback/{provider}` to the built-in drivers in `api/_lib/payments.mjs`. Stripe's API only accepts form-encoded bodies; PayPal needs an OAuth2 token before it will create an order, and the buyer's approval only becomes money after a server-side capture. Both callbacks ignore the request body's claims and re-read the authoritative state from the provider (`GET /v1/checkout/sessions/{id}`, `GET /v2/checkout/orders/{id}`), which is why neither needs a webhook secret: a forged callback costs one extra API read and cannot mark an unpaid order as paid. Anything not yet settled is left `pending` rather than guessed at.

| Provider | Secrets | Webhook endpoint | Events |
| --- | --- | --- | --- |
| Stripe | `STRIPE_SECRET_KEY` | `/v1/callback/stripe` | `checkout.session.completed`, `checkout.session.expired` |
| PayPal | `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` | `/v1/callback/paypal` | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` |

PayPal reads `public_config.environment` (`sandbox` or `live`, falling back to `PAYPAL_ENV`). Both rows ship with `enabled = false`: add the secrets, redeploy, then tick 对外启用 in `/admin` → 支付平台.
