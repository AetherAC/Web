/**
 * 全站 /api/* 只用一个 Serverless Function。
 *
 * 为什么不是「一个文件一个函数」——那是 Vercel 的默认，也是这个目录原本的样子：Hobby 计划一次部署最多
 * 12 个 Serverless Function，而这里有 23 个接口。超了之后构建照旧成功、部署直接失败，报
 * exceeded_serverless_functions_per_deployment，线上停在上一版。2026-08-30 就是这么摔的：站内信整套写完
 * 推上去，`npm test` 全绿、Vercel 的 build 日志也写着 build complete，但 /inbox 和 /api/notifications
 * 全是 404，因为那次部署根本没上线。构建成功不等于部署成功，这个函数就是那次的修法。
 *
 * 处理函数搬到了 api/_routes/：以下划线开头的文件和目录不会被 Vercel 当成函数入口（api/_lib 一直如此），
 * 但照旧能 import。对外的 URL 一个都没变，前端和支付平台的回调地址都不用动。
 *
 * 路由表是写死的静态 import()，不是按 name 拼路径动态 import：Vercel 用 @vercel/nft 静态分析依赖来决定
 * 打包哪些文件，拼出来的路径它追不到，结果是线上 500（模块找不到）而本地一切正常。
 */
const ROUTES = {
  'admin-auto-replies': () => import('./_routes/admin-auto-replies.mjs'),
  'admin-coupons': () => import('./_routes/admin-coupons.mjs'),
  'admin-env': () => import('./_routes/admin-env.mjs'),
  'admin-orders': () => import('./_routes/admin-orders.mjs'),
  'admin-refunds': () => import('./_routes/admin-refunds.mjs'),
  'admin-users': () => import('./_routes/admin-users.mjs'),
  'cancel-order': () => import('./_routes/cancel-order.mjs'),
  checkout: () => import('./_routes/checkout.mjs'),
  coupon: () => import('./_routes/coupon.mjs'),
  'cs-actions': () => import('./_routes/cs-actions.mjs'),
  'cs-message': () => import('./_routes/cs-message.mjs'),
  'cs-session': () => import('./_routes/cs-session.mjs'),
  'cs-workbench': () => import('./_routes/cs-workbench.mjs'),
  'github-progress': () => import('./_routes/github-progress.mjs'),
  'installation-stats': () => import('./_routes/installation-stats.mjs'),
  notifications: () => import('./_routes/notifications.mjs'),
  ldc: () => import('./_routes/ldc.mjs'),
  'linuxdo-userinfo': () => import('./_routes/linuxdo-userinfo.mjs'),
  'ldc-notify': () => import('./_routes/ldc-notify.mjs'),
  'payment-callback': () => import('./_routes/payment-callback.mjs'),
  'refund-approve': () => import('./_routes/refund-approve.mjs'),
  'refund-execute': () => import('./_routes/refund-execute.mjs'),
  'refund-reject': () => import('./_routes/refund-reject.mjs'),
  'refund-request': () => import('./_routes/refund-request.mjs'),
  'refund-transfer': () => import('./_routes/refund-transfer.mjs'),
  'sync-github-groups': () => import('./_routes/sync-github-groups.mjs'),
  telemetry: () => import('./_routes/telemetry.mjs')
}

export const ROUTE_NAMES = Object.keys(ROUTES)

/**
 * 请求到底要哪个接口。
 *
 * 先看 ?route=：vercel.json 里那条 `/api/:path*` 重写就是这么传的，而重写之后 req.url 未必是重写后的
 * 路径。取不到才回退到从 pathname 里剥 /api/ 前缀——本地直接调这个 handler 时走的是这条。
 */
export function routeName(req) {
  const q = req.query?.route
  const fromQuery = Array.isArray(q) ? q.join('/') : q
  if (fromQuery) return String(fromQuery).replace(/^\/+|\/+$/g, '')
  let pathname = String(req.url || '')
  try { pathname = new URL(pathname, 'http://localhost').pathname } catch { /* 相对路径直接用 */ }
  return decodeURIComponent(pathname).replace(/^\/+api\/+/, '').replace(/^\/+|\/+$/g, '')
}

export default async function handler(req, res) {
  const name = routeName(req)
  const load = ROUTES[name]
  if (!load) {
    res.status(404).json({ error: `没有这个接口：/api/${name}` })
    return
  }
  const mod = await load()
  return mod.default(req, res)
}
