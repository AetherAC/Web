# Linux.DO / LDC integration

## Installation order

1. Back up the database. Apply `supabase/ldc.sql` **after** the existing `supabase/schema.sql` installation. The additional script is transactional and re-runnable; it leaves existing settings untouched. Do not reapply the entire base schema merely to install LDC.
2. Configure Linux.DO Connect and the Supabase custom provider as below.
3. Set `SITE_URL`, `LDC_CLIENT_ID`, and `LDC_CLIENT_SECRET` in the Vercel server environment and redeploy. Never use `VITE_` for credentials.
4. Open `/admin` -> Linux.DO / LDC. Configure offers and enable only the desired switches. All switches default to off. Verify an actual authorization and a low-value LDC payment before enabling broadly.

## Linux.DO login

Use Supabase Auth's native **custom OAuth2 provider**, identifier `custom:linuxdo`. This retains Supabase session refresh, existing user IDs, RLS, and Storage/Realtime authorization. No custom JWT signing or synthetic email/password account is used.

| Field | Value |
| --- | --- |
| Provider type | OAuth2 (manual configuration) |
| Identifier | `custom:linuxdo` |
| Authorization URL | `https://connect.linux.do/oauth2/authorize` |
| Token URL | `https://connect.linux.do/oauth2/token` |
| UserInfo URL | `https://aetherac.abnt.it/api/linuxdo-userinfo` |
| Client ID / secret | Linux.DO **Connect** application credentials, stored in Supabase only |
| Email optional | `true` |
| Scopes | Leave empty unless the Connect application explicitly requires scopes |
| PKCE | Keep the provider default enabled; verify compatibility with the registered Connect application |

Register the callback URL displayed by Supabase (normally `https://<project>.supabase.co/auth/v1/callback`) in Linux.DO Connect. Allow the site's `/me`, `/buy` and required same-origin destinations in Supabase Auth Redirect URLs. Keep production redirect allowlists narrow; local `next` validation rejects external origins and backslash/control-character variants.

The UserInfo adapter forwards the supplied bearer token only to the fixed Connect endpoint. It maps Linux.DO's numeric, immutable `id` to OAuth `sub`, returns name/username only, and rejects inactive or silenced accounts. It deliberately drops `api_key`, `external_ids` and email. Supabase's generic provider expects standard claim names; pointing it directly at the Linux.DO raw profile without mapping can produce an empty subject. The adapter never stores or logs provider access tokens.

For existing accounts, enable Supabase **manual identity linking** and use the account page's binding button while already signed in. Do not create another account and attempt to merge by username, display name or an unverified email. The UI switch hides the entry; disable the provider in Supabase as well if authentication itself must be revoked.

References: [Supabase custom providers](https://supabase.com/docs/guides/auth/custom-oauth-providers), [Linux.DO Connect](https://wiki.linux.do/Community/LinuxDoConnect), [Supabase custom provider implementation](https://github.com/supabase/auth/blob/master/internal/api/provider/custom_oauth.go).

## LDC configuration and semantics

LDC credentials come from **LINUX DO Credit**, not the Connect OAuth app. The integration uses its documented EasyPay-compatible MD5 signature protocol, over HTTPS.

- Notification: `https://aetherac.abnt.it/api/ldc-notify` (GET, signed; literal `success` acknowledgement).
- Return: `https://aetherac.abnt.it/me` (each generated payment also includes a local request ID).
- Gateway: `https://credit.linux.do/epay/pay/submit.php` (browser form POST after explicit confirmation).
- A return URL alone **never** grants a benefit. The notification must pass signature, merchant, type, status, order ID, and exact-amount checks, or an owner-triggered server query must confirm those details.

Admin configuration is saved as `site_settings.ldc_config.value.value`. Amounts use integers: `ldc_minor=10000` means **100.00 LDC**; `discount_minor=500` is 5.00 USD for a USD offer. The LDC amount and coupon value are separately configurable; this is not an automatic currency exchange rate.

Example offer:

```json
{
  "id": "pro-discount",
  "kind": "discount",
  "name": "PRO discount",
  "enabled": true,
  "ldc_minor": 10000,
  "discount_minor": 500,
  "currency": "USD",
  "sku": "PRO",
  "valid_days": 30
}
```

- **Discount**: exact SKU required. Exchange LDC for a one-time, account-bound SKU coupon, then apply it to checkout. The remaining amount uses an existing payment method. This intentionally avoids a fragile distributed transaction between LDC and a cash gateway.
- **Coupon**: SKU may be blank for any same-currency product. Minimum order amount equals coupon face value, so a coupon cannot silently lose value on a cheaper product.
- A fully discounted order is fulfilled by the server's atomic zero-total checkout function, without contacting a payment provider. The internal `coupon` payment provider must remain disabled in public gateway choices.
- Only one coupon per order; no stacking. Paid benefits preserve the offer snapshot taken when the LDC request was created. Validity starts at settlement, not before payment.
- Existing requests survive disabled features for reconciliation. New requests/payments are blocked by the corresponding switch, but verified late payments are still fulfilled.
- API creation limits: at most five unexpired pending requests and twenty requests per user per hour, serialized by a database row lock.

## Customer-service LDC requests

The assigned staff member or an administrator opens the conversation's LDC panel, enters an amount/reason, and creates a request. The database records requester, beneficiary, conversation, amount, purpose and expiration; a system message appears in the conversation. Other staff cannot initiate requests for an assigned conversation they do not control.

The user opens the LDC panel or account page, reads the amount/reason, then confirms and authorizes on Credit. Staff never receive a capability to debit a user's balance directly or open the owner's payment form. The LDC gateway may be authorized by a different Credit payer; the **site beneficiary remains the recorded site user**, and no claim is made that the payer's Credit identity equals the site's linked OAuth identity.

Unconsented requests can be declined. Once a payment form has been issued, the site does not pretend a local cancellation invalidates the provider's payment page. Pending requests remain queryable after expiry; use “I have paid / sync status” to reconcile delayed notifications. Refunds of LDC must currently be handled through the Credit merchant tooling; this integration does not automatically refund LDC when a later artifact order is cancelled/refunded. A cancelled *unpaid* artifact order follows the existing coupon-release behavior.

## Message latency changes

- Optimistic outgoing message with a client-generated UUID; API response and Realtime event deduplicate on the same ID.
- RLS-authorized INSERTs are displayed through the existing message presenter immediately. Edits/recalls and staff-only revision content still refresh through the authenticated API.
- Message/session bursts are coalesced at 120 ms; latest 200 messages are queried descending and returned chronologically. This fixes long conversations being stuck at the oldest 200 messages.
- One request in flight plus one queued refresh; stale responses cannot replace a newly selected conversation.
- Realtime recovery and tab/network resumption force a refresh. Active visible conversations use 3-second fallback polling when disconnected, 30-second consistency checks when connected. The workbench uses 5-second disconnected fallback.
- A failed automatic reply no longer reports the already-persisted user message as failed.
- No additional paid/free third-party messaging service is introduced. Ensure `cs_messages` and `cs_sessions` are in the existing Supabase Realtime publication. Actual end-to-end latency still requires a two-browser production/staging test; code inspection is not a latency measurement.

## Verification and rollback

`npm run test:ldc` is offline: all network calls are mocked, no real tokens, no LDC transfers. It covers decimal boundaries, signature mutation, request ownership, assigned-agent permissions, consent, authoritative amount checks and exact callback acknowledgement. The SQL assertions in this test are installation guards, **not** a live PostgreSQL concurrency test.

Run `npm test`, then on a staging database verify duplicate simultaneous notifications create one coupon, reused provider trade numbers fail, zero-total checkout rolls back on failed redemption, anonymous/authenticated roles cannot execute settlement RPCs, and a user cannot view another user's LDC requests. Verify Linux.DO login, refresh, sign-out, account binding and two-browser chat delivery with more than 200 messages. In the browser also test failed sends, recall/edit, disconnected Realtime, switching conversations during an in-flight request, narrow layouts, and LDC return-page reconciliation.

To disable, turn off the LDC switches and the login entry, and disable the OAuth provider if needed. Keep `/api/ldc-notify`, credentials, `ldc_orders`, and settlement functions until outstanding payments are reconciled. Do not drop financial records or roll back to code that cannot settle outstanding requests.

Protocol reference: [LINUX DO Credit API](https://credit.linux.do/docs/api).
