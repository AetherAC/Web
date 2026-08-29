/**
 * §2/§4/§7 客服前端的共用一层：取配置、开会话、收发消息、订阅推送、广播打字状态、上传附件。
 *
 * 为什么是一个 composable 而不是每个组件各写一遍：用户端的挂件和客服端的工作台面对同一套接口，
 * 而其中三件事一旦两边不一致就会表现为难查的 bug——
 *   1. 收到 Realtime 推送后必须回头拉一次接口。推来的行是残缺的（撤回的空壳、visible_to_user=false
 *      的行），直接把它塞进列表的结果是用户看到自己撤回的原文。
 *   2. 附件路径必须是三段。自己拼字符串的一侧会上传成功而发消息被拒。
 *   3. 打字状态走 broadcast 而不是落库。两边用不同的 channel 名就是「对方永远不显示正在输入」。
 */

import { computed, onScopeDispose, ref, type Ref } from 'vue'
import {
  ATTACHMENT_BUCKET, MESSAGE_MAX_CHARS, attachmentKindOf, attachmentPath,
  checkAttachmentSize, sessionCapabilities
} from '../../../shared/cs.mjs'
import { supabase, useAuth } from './auth'

export type CsChannel = 'presale' | 'postsale'

export interface CsAttachment {
  path: string
  kind: 'image' | 'file' | 'video'
  name: string
  size: number
  mime: string
}

export interface CsMessage {
  id: string
  session_id: string
  sender_id: string | null
  sender_role: 'user' | 'agent' | 'admin' | 'system' | 'auto'
  body: string
  format: 'plain' | 'markdown' | 'bbcode' | 'html'
  attachments: CsAttachment[]
  auto_reply: boolean
  authored_by?: string | null
  recalled: boolean
  recalled_at: string | null
  edited_at: string | null
  edit_count: number
  created_at: string
  read_by_user_at?: string | null
  read_by_agent_at?: string | null
  revisions?: Array<{ kind: string; body: string; format: string; revision: number; created_at: string }>
}

export interface CsSession {
  id: string
  channel: CsChannel
  user_id: string
  order_id: string | null
  agent_id: string | null
  status: 'open' | 'closed'
  admin_mode: 'none' | 'normal' | 'readonly' | 'blind'
  admin_id: string | null
  close_reason: string | null
  timed_out: boolean
  first_response_seconds: number | null
  opened_at: string
  closed_at: string | null
  last_activity_at: string | null
  last_user_message_at: string | null
  last_agent_message_at: string | null
  created_at: string
}

export interface CsCapabilities {
  can_see: boolean
  can_post: boolean
  can_claim: boolean
  can_close: boolean
  can_reopen: boolean
  can_monitor: boolean
  can_see_revisions: boolean
  is_owner: boolean
  is_agent: boolean
  is_admin: boolean
}

export interface CsConfig {
  allow_html: boolean
  allow_bbcode: boolean
  typing_trigger: 'keypress' | 'focus'
  upload_limit_mb: { image: number; file: number; video: number }
  message_max_chars: number
  max_attachments: number
  timeout_minutes: { presale: number; postsale: number }
  mutable_window_ms: number
}

/** 兜底配置。取不到接口时输入框仍然可用，只是按最保守的一档限制。 */
const FALLBACK_CONFIG: CsConfig = {
  allow_html: false, allow_bbcode: true, typing_trigger: 'keypress',
  upload_limit_mb: { image: 10, file: 25, video: 100 },
  message_max_chars: MESSAGE_MAX_CHARS, max_attachments: 10,
  timeout_minutes: { presale: 30, postsale: 60 }, mutable_window_ms: 120000
}

/** 配置只取一次，挂件和工作台共用同一个 promise——两个组件同时挂载不该打两次接口。 */
let configPromise: Promise<CsConfig> | null = null

export function csApi(path: string, options: RequestInit = {}) {
  const auth = useAuth()
  const token = auth.session.value?.access_token
  return fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }).then(async r => {
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`)
    return data
  })
}

export function loadCsConfig(): Promise<CsConfig> {
  if (!configPromise) {
    configPromise = csApi('/api/cs-message?view=config')
      .then(data => ({ ...FALLBACK_CONFIG, ...data }))
      .catch(() => {
        // 失败不缓存：网络恢复后下一次挂载应该重新试，而不是一整个会话都用兜底值。
        configPromise = null
        return FALLBACK_CONFIG
      })
  }
  return configPromise
}

export const formatBytes = (n: number) => {
  const bytes = Number(n) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const csTime = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/**
 * 一条会话的状态机。
 *
 * sessionId 用 ref 而不是参数：工作台点另一个会话时是同一个 composable 换一个 id，
 * 重建一个 composable 会把配置、上传中的文件、正在输入的草稿一起丢掉。
 */
export function useCsThread() {
  const auth = useAuth()
  const session = ref<CsSession | null>(null)
  const capabilities = ref<CsCapabilities | null>(null)
  const messages = ref<CsMessage[]>([])
  const config = ref<CsConfig>(FALLBACK_CONFIG)
  const loading = ref(false)
  const sending = ref(false)
  const error = ref('')
  /** 对方是否正在输入。§7 的双向指示：两边用同一个 broadcast 通道，各自只显示对方那一侧。 */
  const peerTyping = ref(false)
  const uploading = ref<string[]>([])
  const pending = ref<CsAttachment[]>([])

  let channel: any = null
  let peerTimer: any = null
  let typingSentAt = 0
  let refetching = false

  loadCsConfig().then(c => { config.value = c })

  const closed = computed(() => !!session.value && session.value.status !== 'open')
  const canPost = computed(() => !!capabilities.value?.can_post)
  const isOwner = computed(() => !!capabilities.value?.is_owner)

  /**
   * 拉一遍消息。Realtime 推送之后必须走这里而不是把推来的行 push 进列表——
   * 推来的是数据库原始行，撤回时那一行的 body 是空的但 revisions 不在里面，
   * 而 visible_to_user=false 的行对用户根本不该出现。
   */
  async function refresh(sessionId?: string) {
    const id = sessionId || session.value?.id
    if (!id) return
    if (refetching) return
    refetching = true
    try {
      const data = await csApi(`/api/cs-message?session_id=${encodeURIComponent(id)}&limit=200`)
      session.value = data.session
      capabilities.value = data.capabilities
      messages.value = data.messages || []
      error.value = ''
    } catch (e: any) {
      error.value = e.message
    } finally {
      refetching = false
    }
  }

  /** 订阅这条会话。行推送触发重新拉取，broadcast 只用来传打字状态。 */
  function subscribe(sessionId: string) {
    unsubscribe()
    if (!supabase) return
    channel = supabase.channel(`cs:${sessionId}`, { config: { broadcast: { self: false } } })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'cs_messages', filter: `session_id=eq.${sessionId}` },
        () => { refresh(sessionId) })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'cs_sessions', filter: `id=eq.${sessionId}` },
        () => { refresh(sessionId) })
      .on('broadcast', { event: 'typing' }, ({ payload }: any) => {
        // 只显示对方那一侧。自己那一侧也会收到时（self:false 之外的兜底），as_role 相同就忽略。
        const mine = capabilities.value?.is_owner ? 'user' : 'agent'
        if (payload?.as_role === mine) return
        peerTyping.value = true
        clearTimeout(peerTimer)
        // 3 秒没有新信号就熄灭。打字状态不落库，所以没有「停止输入」这个事件——
        // 靠超时熄灭是唯一不会卡住的做法（对方直接关掉标签页时不会发停止信号）。
        peerTimer = setTimeout(() => { peerTyping.value = false }, 3000)
      })
      .subscribe()
  }

  function unsubscribe() {
    if (channel && supabase) supabase.removeChannel(channel)
    channel = null
    clearTimeout(peerTimer)
    peerTyping.value = false
  }

  /** 切到另一条会话（工作台点列表）或第一次进入。 */
  async function attach(sessionId: string) {
    loading.value = true
    pending.value = []
    messages.value = []
    try {
      await refresh(sessionId)
      subscribe(sessionId)
      if (capabilities.value?.can_see) markRead().catch(() => {})
    } finally {
      loading.value = false
    }
  }

  /** §2.1 开会话。presale 不带 order_id，postsale 必须带。 */
  async function open(channelName: CsChannel, orderId?: string | null) {
    loading.value = true
    error.value = ''
    try {
      const data = await csApi('/api/cs-session', {
        method: 'POST',
        body: JSON.stringify({ action: 'open', channel: channelName, order_id: orderId || null })
      })
      session.value = data.session
      capabilities.value = data.capabilities
      subscribe(data.session.id)
      await refresh(data.session.id)
      markRead().catch(() => {})
      return data
    } catch (e: any) {
      error.value = e.message
      throw e
    } finally {
      loading.value = false
    }
  }

  async function send(body: string, format: CsMessage['format'] = 'markdown') {
    if (!session.value) return
    const text = String(body ?? '')
    if (!text.trim() && pending.value.length === 0) return
    sending.value = true
    error.value = ''
    try {
      const data = await csApi('/api/cs-message', {
        method: 'POST',
        body: JSON.stringify({
          action: 'send', session_id: session.value.id,
          body: text, format, attachments: pending.value
        })
      })
      pending.value = []
      // 乐观追加自己那条，再拉一次拿自动回复和服务端时间戳。
      if (data.message) messages.value = [...messages.value, data.message]
      await refresh()
      return data
    } catch (e: any) {
      error.value = e.message
      throw e
    } finally {
      sending.value = false
    }
  }

  async function recall(messageId: string) {
    await csApi('/api/cs-message', {
      method: 'POST', body: JSON.stringify({ action: 'recall', message_id: messageId })
    })
    await refresh()
  }

  async function edit(messageId: string, body: string) {
    await csApi('/api/cs-message', {
      method: 'POST', body: JSON.stringify({ action: 'edit', message_id: messageId, body })
    })
    await refresh()
  }

  async function markRead() {
    if (!session.value) return
    await csApi('/api/cs-message', {
      method: 'POST', body: JSON.stringify({ action: 'read', session_id: session.value.id })
    })
  }

  /**
   * §7 广播一次打字状态。节流到 1.5 秒一次——每次按键一次 broadcast 是几十条无意义的帧，
   * 而对端的熄灭超时是 3 秒，1.5 秒足够让它一直亮着。
   */
  function notifyTyping() {
    if (!channel || !session.value || !canPost.value) return
    const now = Date.now()
    if (now - typingSentAt < 1500) return
    typingSentAt = now
    const asRole = capabilities.value?.is_owner ? 'user' : 'agent'
    channel.send({ type: 'broadcast', event: 'typing', payload: { as_role: asRole, at: now } })
  }

  /**
   * §4.5/§4.6 上传一个附件。前端这一层的检查是为了给出体面的提示，真实判定在服务端——
   * 所以这里超限时直接不传，而不是传上去等服务端拒。
   */
  async function upload(file: File) {
    if (!session.value || !supabase || !auth.user.value) return null
    if (pending.value.length >= config.value.max_attachments) {
      error.value = `一条消息最多 ${config.value.max_attachments} 个附件`
      return null
    }
    const kind = attachmentKindOf(file.type)
    const verdict = checkAttachmentSize(kind, file.size, config.value.upload_limit_mb)
    if (!verdict.ok) { error.value = verdict.error; return null }

    const path = attachmentPath(session.value.id, auth.user.value.id, file.name)
    uploading.value = [...uploading.value, file.name]
    try {
      const { error: upErr } = await supabase.storage.from(ATTACHMENT_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream' })
      if (upErr) throw new Error(upErr.message)
      const item: CsAttachment = {
        path, kind, name: file.name.slice(0, 200), size: file.size, mime: file.type || ''
      }
      pending.value = [...pending.value, item]
      return item
    } catch (e: any) {
      error.value = `上传失败：${e.message}`
      return null
    } finally {
      uploading.value = uploading.value.filter(n => n !== file.name)
    }
  }

  /** 撤掉一个还没发出去的附件。桶里那个对象也删掉，否则每次改主意都留一份垃圾。 */
  async function dropPending(path: string) {
    pending.value = pending.value.filter(a => a.path !== path)
    if (supabase) await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]).catch(() => {})
  }

  /** 附件的可下载地址。桶是私有的，所以要签一个短时效的 URL。 */
  async function signedUrl(path: string, seconds = 300) {
    if (!supabase) return ''
    const { data } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrl(path, seconds)
    return data?.signedUrl || ''
  }

  onScopeDispose(unsubscribe)

  return {
    session, capabilities, messages, config, loading, sending, error, peerTyping,
    uploading, pending, closed, canPost, isOwner,
    attach, open, refresh, send, recall, edit, markRead, notifyTyping,
    upload, dropPending, signedUrl, subscribe, unsubscribe
  }
}

/**
 * §2.4 客服在线状态。心跳单独一层，因为工作台和会话列表都要它，而它和某一条会话无关。
 *
 * 手动下线和心跳超时是两件事：online=false 是「我按了下线」，心跳过期是「浏览器关了」。
 * 心跳只刷 last_heartbeat 而不动 online，所以按了下线的人不会被自己的心跳复活。
 */
export function useCsPresence(intervalMs = 45000) {
  const online = ref(false)
  const note = ref('')
  const maxConcurrent = ref<number | null>(null)
  const busy = ref(false)
  const error = ref('')
  let timer: any = null

  async function push(payload: Record<string, unknown>) {
    busy.value = true
    error.value = ''
    try {
      const data = await csApi('/api/cs-session', {
        method: 'POST', body: JSON.stringify({ action: 'presence', ...payload })
      })
      if (data.agent) {
        online.value = data.agent.online === true
        note.value = data.agent.status_note || ''
        maxConcurrent.value = data.agent.max_concurrent ?? null
      }
      return data
    } catch (e: any) {
      error.value = e.message
      throw e
    } finally {
      busy.value = false
    }
  }

  /** 心跳：不带 online，所以服务端只刷时间戳。 */
  const beat = () => push({}).catch(() => {})

  function start() {
    stop()
    beat()
    timer = setInterval(beat, intervalMs)
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  const setOnline = (value: boolean) => push({ online: value })
  const setNote = (value: string) => push({ status_note: value })

  onScopeDispose(stop)
  return { online, note, maxConcurrent, busy, error, start, stop, beat, setOnline, setNote, push }
}

/** 组件里判「这条消息能不能撤回/编辑」。和服务端同一套条件，少一条就是一个点了报错的按钮。 */
export function mutable(message: CsMessage, userId: string | undefined, windowMs: number) {
  if (!userId || message.sender_id !== userId) return false
  if (message.recalled || message.auto_reply) return false
  if (message.sender_role === 'system') return false
  const age = Date.now() - new Date(message.created_at).getTime()
  return Number.isFinite(age) && age <= windowMs
}

export { sessionCapabilities }
export type { Ref }
