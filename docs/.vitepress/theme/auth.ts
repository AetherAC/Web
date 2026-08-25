import { computed, readonly, ref } from 'vue'
import { createClient, type Session, type User } from '@supabase/supabase-js'

export type UserGroup = 'default' | 'read' | 'coworker' | 'admin'
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const supabase = url && key ? createClient(url, key) : null
const userState = ref<User | null>(null)
const sessionState = ref<Session | null>(null)
const groupState = ref<UserGroup>('default')
const readyState = ref(false)
let initialized = false

async function refreshProfile() {
  if (!supabase || !userState.value) { groupState.value = 'default'; return }
  const { data } = await supabase.from('user_profiles').select('group_name').eq('user_id', userState.value.id).maybeSingle()
  groupState.value = (data?.group_name ?? 'default') as UserGroup
}
export async function initializeAuth() {
  if (initialized) return
  initialized = true
  if (!supabase) { readyState.value = true; return }
  const { data } = await supabase.auth.getSession()
  sessionState.value = data.session
  userState.value = data.session?.user ?? null
  await refreshProfile()
  supabase.auth.onAuthStateChange((_event, session) => {
    sessionState.value = session
    userState.value = session?.user ?? null
    queueMicrotask(() => refreshProfile())
  })
  readyState.value = true
}
export function useAuth() {
  initializeAuth()
  return {
    configured: Boolean(supabase),
    user: readonly(userState),
    session: readonly(sessionState),
    group: readonly(groupState),
    ready: readonly(readyState),
    isAdmin: computed(() => groupState.value === 'admin'),
    canEditContent: computed(() => ['coworker', 'admin'].includes(groupState.value)),
    refreshProfile,
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
