// Route shapes that both the browser and the payment providers have to agree on.
//
// This is its own module, with no imports, for two reasons. It keeps `orderPath` out of auth.ts, which
// reads `import.meta.env` and therefore cannot be loaded by the Node test runner; and it gives
// tests/api-smoke.mjs something it can import next to api/_lib/payments.mjs to prove the two halves
// still build the same URL.

/**
 * Link to an order.
 *
 * The id is a query parameter, not a path segment, and that is load-bearing. VitePress resolves every
 * route against a hash map of the .md files it built, so `/order/<uuid>` has no entry: `pathToFile`
 * returns null, the router throws "Page not found", and the page is replaced by the theme's 404 as soon
 * as JS boots. A server-side rewrite could not fix it — it makes the initial HTML correct and the client
 * router discards it a moment later, which is exactly how this shipped and stayed hidden from curl.
 *
 * `/order` is a real page, so this form survives both an in-app click and a cold load. Keep it in sync
 * with `orderUrl` in api/_lib/payments.mjs, which builds the absolute form for the providers' return_url;
 * a test asserts the two agree.
 */
export const orderPath = (orderId: string) => `/order?order_id=${encodeURIComponent(orderId)}`
