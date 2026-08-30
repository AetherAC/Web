// §9 收件箱的共享状态与请求封装。
//
// 未读数放在模块级而不是各组件自己一份：角标在每一页的顶栏上，列表只在 /inbox 上。两处各拉一次的话，
// 在收件箱里点掉一条之后顶栏还挂着旧数字，而那个数字要等下一次整页加载才会消——用户会以为有一条
// 怎么点都读不掉的站内信。
import { readonly, ref } from 'vue'
import { useAuth } from './auth'

export interface InboxSettings {
  auto_archive_days: number
  read_dwell_ms: number
  notify_browser: boolean
  notify_email: boolean
}

/**
 * 接口拿不到时的兜底。这里的 2000 是 §9.7 的默认值，和 api/notifications.mjs 里 inboxSettings 的
 * 默认参数同一个数——它只在请求失败时用得上，正常路径永远读服务端那份，因为那个值是可配的。
 */
const FALLBACK: InboxSettings = {
  auto_archive_days: 30, read_dwell_ms: 2000, notify_browser: true, notify_email: false
}

const unread = ref(0)
const pending = ref(0)

/**
 * 带 token 的请求。和 cs.ts 的 csApi 不同，这个在非 2xx 时不抛。
 *
 * 收件箱有两个状态码本身就是信息：归档待处理的通知回 409（正文里还带一个 pending 计数），批准退款
 * 缺 confirm 回 428。抛成 Error 之后只剩一句话，而调用方要按状态码决定弹不弹二次确认框。
 */
export async function inboxApi(path: string, init: RequestInit = {}) {
  const auth = useAuth()
  const token = auth.session.value?.access_token
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  })
  const data = await response.json().catch(() => ({} as any))
  return { ok: response.ok, status: response.status, data: data as any }
}

let settingsPromise: Promise<InboxSettings> | null = null

/** §14 里和收件箱有关的几个配置。一次会话只拉一次，失败不缓存。 */
export function loadInboxSettings(): Promise<InboxSettings> {
  if (!settingsPromise) {
    settingsPromise = inboxApi('/api/notifications?view=settings')
      .then(({ ok, data }) => (ok ? { ...FALLBACK, ...data } : FALLBACK))
      .catch(() => { settingsPromise = null; return FALLBACK })
  }
  return settingsPromise
}

/**
 * 角标。未读和待处理是两个数，不是一个：§9.6 的待办即使读过也还挡在那里，一个管理员可能全读过了
 * 但还有三条等他批。只显示未读数的话，那三条不会再提醒任何人。
 */
export async function refreshBadge() {
  const auth = useAuth()
  if (!auth.user.value) { unread.value = 0; pending.value = 0; return }
  try {
    const { ok, data } = await inboxApi('/api/notifications?view=unread')
    if (!ok) return
    unread.value = Number(data.unread) || 0
    pending.value = Number(data.pending) || 0
  } catch { /* 角标拉不到就维持旧值，不值得为它报错 */ }
}

/** 本地扣减，用于点掉一条之后立刻更新角标，不必为一个数字再跑一次接口。 */
export function decrementUnread(n = 1) {
  unread.value = Math.max(0, unread.value - n)
}

export const useInboxBadge = () => ({
  unread: readonly(unread), pending: readonly(pending), refreshBadge, decrementUnread
})

/** 角标上的数字。超过 99 就不再精确——那时候「还有多少条」已经不是有用的信息了。 */
export const badgeText = (n: number) => (n > 99 ? '99+' : String(n))
