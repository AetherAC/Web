// Proves the order route resolves in the browser — the half a curl cannot see.
//
// `/order/<uuid>` answered HTTP 200 for as long as it was broken: Vercel's rewrite made the server HTML
// correct, then the client router threw it away and rendered its own 404. The failure is entirely in
// VitePress's route resolution, so that is what this drives, against the real dist/hashmap.json.
//
// `sanitizeFileName` is imported from VitePress rather than copied. The three lines around it are
// mirrored from node_modules/vitepress/dist/client/app/utils.js (`pathToFile`, the `inBrowser` && PROD
// branch) because importing that function directly pulls in `@siteData`, a Vite virtual module that does
// not exist outside a bundle. The mirror cannot drift silently: the keys it derives are looked up in
// hashmap.json, which VitePress itself wrote, so a change in either half makes the lookup miss and this
// test fail. Re-read that function on a VitePress upgrade anyway.
//
// Run after a build; it reads dist/.
import assert from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { sanitizeFileName } from '../node_modules/vitepress/dist/client/shared.js'

const hashMapPath = new URL('../docs/.vitepress/dist/hashmap.json', import.meta.url)
if (!existsSync(hashMapPath)) {
  console.error('Route resolution: SKIPPED — no build found. Run `npm run build` first (this test reads dist/hashmap.json).')
  process.exit(1)
}
const hashMap = JSON.parse(readFileSync(hashMapPath, 'utf8'))

/** null means "no page module" — the exact value that makes router.loadPage throw and swap in the 404. */
function resolve(href) {
  // router.loadPage passes the pathname only; search and hash are dropped before this point.
  const { pathname } = new URL(href, 'http://a.com')
  let pagePath = decodeURIComponent(pathname.replace(/\.html$/, '')).replace(/\/$/, '/index')
  pagePath = sanitizeFileName(pagePath.slice('/'.length).replace(/\//g, '_') || 'index') + '.md'
  let hash = hashMap[pagePath.toLowerCase()]
  if (!hash) {
    pagePath = pagePath.endsWith('_index.md') ? pagePath.slice(0, -9) + '.md' : pagePath.slice(0, -3) + '_index.md'
    hash = hashMap[pagePath.toLowerCase()]
  }
  return hash ? `${pagePath}.${hash}.js` : null
}

// Sanity-check the mirror itself before trusting a null from it: if this derivation had drifted from
// VitePress's, every lookup would miss and the assertions below would "pass" for the wrong reason.
assert.ok(resolve('/'), 'the mirrored derivation is broken — even the home page does not resolve')

const ORDER_ID = '5030c2b9-3328-43f3-b595-62ef3a2663d1'

assert.strictEqual(resolve(`/order/${ORDER_ID}`), null,
  'the old path form must resolve to null — that null is the 404 a buyer saw returning from a payment')

const queryForm = resolve(`/order?order_id=${ORDER_ID}&paid=1`)
assert.ok(queryForm, 'the query form must resolve to a page module, or the order page 404s again')
assert.match(queryForm, /^order\.md\.[A-Za-z0-9_-]+\.js$/, `expected the built order page module, got ${queryForm}`)

// Every route the site links to, so a future rename cannot quietly 404 the same way.
for (const route of ['/', '/blog', '/news', '/progress', '/studio', '/login', '/register', '/me', '/buy', '/admin', '/order']) {
  assert.ok(resolve(route), `${route} does not resolve to a page module`)
}

console.log('Route resolution: OK')
