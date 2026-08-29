import { computed, readonly, ref } from 'vue'
import { createClient, type Session, type User } from '@supabase/supabase-js'

// 用户组的排名、标签和顺序都在 shared/groups.mjs 里，api/ 下的函数读的是同一个文件。这里只加 TS 类型：
// 界面显示的权限和接口实际执行的权限不一致，比什么都不显示更糟。
import { EDITOR_GROUPS, GROUP_LABEL as LABELS, GROUP_ORDER as ORDER, GROUP_RANK as RANKS, RANK, isEditor, rankOf as rankFor } from '../../../shared/groups.mjs'

export type UserGroup = 'default' | 'read' | 'coworker' | 'presale' | 'postsale' | 'cs' | 'admin'
export const GROUP_RANK = RANKS as Record<UserGroup, number>
export const GROUP_ORDER = ORDER as UserGroup[]
export const GROUP_LABEL = LABELS as Record<UserGroup, string>
export const rankOf = rankFor as (group: string | null | undefined) => number
export { EDITOR_GROUPS, RANK, isEditor }

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const supabase = url && key ? createClient(url, key) : null
const userState = ref<User | null>(null)
const sessionState = ref<Session | null>(null)
const groupState = ref<UserGroup>('default')
const readyState = ref(false)
let initialized = false
const synced = new Set<string>()

async function refreshProfile() {
  if (!supabase || !userState.value) { groupState.value = 'default'; return }
  const { data } = await supabase.from('user_profiles').select('group_name').eq('user_id', userState.value.id).maybeSingle()
  groupState.value = (data?.group_name ?? 'default') as UserGroup
}

/**
 * §6：GitHub 登录后按团队重算权限组。
 *
 * 一个 user id 只打一次，因为 onAuthStateChange 在 token 刷新时也可能报 SIGNED_IN，而这个接口每次要向
 * GitHub 发 6 个请求。同步失败就静默——权限不该因为 GitHub 抖一下而掉，用户手里的组保持原样。
 */
async function syncGitHubGroup() {
  const user = userState.value
  if (!user || typeof fetch === 'undefined') return
  const isGitHub = user.app_metadata?.provider === 'github' || (user.app_metadata?.providers ?? []).includes('github')
  if (!isGitHub || synced.has(user.id)) return
  synced.add(user.id)
  try {
    const token = sessionState.value?.access_token
    if (!token) return
    const response = await fetch('/api/sync-github-groups', { headers: { Authorization: `Bearer ${token}` } })
    const data = await response.json().catch(() => null)
    if (data?.synced) await refreshProfile()
  } catch { /* 同步是尽力而为，不影响登录 */ }
}

export async function initializeAuth() {
  if (initialized) return
  initialized = true
  if (!supabase) { readyState.value = true; return }
  const { data } = await supabase.auth.getSession()
  sessionState.value = data.session
  userState.value = data.session?.user ?? null
  await refreshProfile()
  void syncGitHubGroup()
  supabase.auth.onAuthStateChange((_event, session) => {
    sessionState.value = session
    userState.value = session?.user ?? null
    queueMicrotask(async () => { await refreshProfile(); void syncGitHubGroup() })
  })
  readyState.value = true
}

export function useAuth() {
  initializeAuth()
  const rank = computed(() => rankOf(groupState.value))
  return {
    configured: Boolean(supabase),
    user: readonly(userState),
    session: readonly(sessionState),
    group: readonly(groupState),
    ready: readonly(readyState),
    rank,
    groupLabel: computed(() => GROUP_LABEL[groupState.value] ?? groupState.value),
    isAdmin: computed(() => rank.value >= RANK.ADMIN),
    // 不是 rank 阈值：§6 的优先级排的是客服分配顺序，售前客服在那里高于文案，但不该因此能发文章。
    canEditContent: computed(() => isEditor(groupState.value)),
    // §2.2 的权限组：能接工单的人。presale/postsale/cs/admin。
    isStaff: computed(() => rank.value >= RANK.STAFF),
    isPresale: computed(() => ['presale', 'cs', 'admin'].includes(groupState.value)),
    isPostsale: computed(() => ['postsale', 'cs', 'admin'].includes(groupState.value)),
    // §12.2：read 及以上能看全部订单，已确认是有意的——进组织就是获得这个可见性的方式。
    canViewOrders: computed(() => rank.value >= RANK.MEMBER),
    refreshProfile,
    syncGitHubGroup,
    async signOut() { await supabase?.auth.signOut(); location.href = '/' },
    requireUser(next = '/') {
      if (typeof window !== 'undefined' && readyState.value && !userState.value) location.href = `/login?next=${encodeURIComponent(next)}`
      return Boolean(userState.value)
    }
  }
}
export function authRedirect(fallback = '/me') {
  const next = new URLSearchParams(location.search).get('next')
  location.href = next?.startsWith('/') ? next : fallback
}
