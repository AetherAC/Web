/**
 * §2/§4/§7 客服前端的共用一层：取配置、开会话、收发消息、订阅推送、广播打字状态、上传附件。
 *
 * 为什么是一个 composable 而不是每个组件各写一遍：用户端的挂件和客服端的工作台面对同一套接口，
 * 而其中三件事一旦两边不一致就会表现为难查的 bug——
 *   1. RLS 验证过的 INSERT 用共享 presenter 即时显示；UPDATE/撤回仍回 API 拉取。
 *      修订历史只由服务端提供，不把数据库原始推送直接当作完整消息。
 *   2. 附件路径必须是三段。自己拼字符串的一侧会上传成功而发消息被拒。
 *   3. 打字状态走 broadcast 而不是落库。两边用不同的 channel 名就是「对方永远不显示正在输入」。
 */

import { computed, onScopeDispose, ref, type Ref } from 'vue'
import {
  ATTACHMENT_BUCKET, MESSAGE_MAX_CHARS, attachmentKindOf, attachmentPath,
  checkAttachmentSize, presentMessage, sessionCapabilities
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
  delivery?: 'sending' | 'failed'
  created_at: string
  read_by_user_at?: string | null
  read_by_agent_at?: string | null
  /**
   * 客服那一侧才有的两个字段，由 shared/cs.mjs 的 presentMessage 挂上（用户那侧连字段都被删掉）。
   *
   * 这里原来写的是 `revisions`，那个名字从来没有出现在接口的答复里——presentMessage 发的是
   * recalled_body 和 edit_history 两个字段。名字对不上的表现不是报错，而是「查看历史」那个按钮
   * 永远不出现：v-if 判的是一个恒为 undefined 的属性，于是 §2.11 的编辑痕迹在工作台上根本看不到。
   */
  recalled_body?: string
  edit_history?: Array<{ body: string; format: string; revision: number; created_at: string }>
}

export interface CsSession {
  id: string
  channel: CsChannel
  user_id: string
  order_id: string | null
  agent_id: string | null
  status: 'open' | 'closed'
  admin_mode: 'normal' | 'blind'
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
  rating?: number | null
  rating_comment?: string | null
  rated_at?: string | null
  /** 接口补上的显示名，不是表里的列。用户端要看到客服叫什么，客服端要看到用户叫什么。 */
  agent_name?: string | null
  user_name?: string | null
}

export interface CsCapabilities {
  can_see: boolean
  can_post: boolean
  can_claim: boolean
  can_close: boolean
  can_reopen: boolean
  can_monitor: boolean
  can_rate: boolean
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
  let activeId: string | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  let realtimeReady = false
  let disposed = false
  const outbox = new Map<string, CsMessage>()
  /** refresh 的串行化状态：最多一次在飞 + 一次排队，见 refresh 的注释。 */
  let running: Promise<void> | null = null
  let pendingId: string | null = null
  let pendingPromise: Promise<void> | null = null
  /** 签好的附件地址，path -> { url, 到期时间 }。见 signedUrls。 */
  const urlCache = new Map<string, { url: string; expires: number }>()

  loadCsConfig().then(c => { config.value = c })

  const closed = computed(() => !!session.value && session.value.status !== 'open')
  const canPost = computed(() => !!capabilities.value?.can_post)
  const isOwner = computed(() => !!capabilities.value?.is_owner)

  async function fetchThread(id: string) {
    try {
      const data = await csApi(`/api/cs-message?session_id=${encodeURIComponent(id)}&limit=200`)
      if (disposed || id !== activeId) return
      session.value = data.session
      capabilities.value = data.capabilities
      const received = data.messages || []
      const ids = new Set(received.map((m: CsMessage) => m.id))
      for (const key of ids) outbox.delete(key as string)
      messages.value = [...received, ...Array.from(outbox.values()).filter(m => m.session_id === id && !ids.has(m.id))]
      error.value = ''
    } catch (e: any) {
      if (!disposed && id === activeId) error.value = e.message
    }
  }

  /**
   * 拉取权威消息窗口。INSERT 可以先展示安全投影，但编辑/撤回历史、可见性和能力仍以 API 为准。
   *
   * 并发的调用会排队，不会被丢掉。原来是「已经在拉了就直接 return」，而关闭会话这件事恰好总是
   * 同时推两条（cs_messages 插一条系统提示 + cs_sessions 改 status），后一条被丢掉的结果就是
   * 对方已经结束了会话，而这一侧还停在「进行中」——只有刷新页面才会发现。这里改成最多一次在飞、
   * 一次排队，排队的那次总用最新请求的 id（工作台切会话时不会拉回上一条）。
   */
  function refresh(sessionId?: string): Promise<void> {
    const id = sessionId || activeId
    if (!id || disposed || id !== activeId) return Promise.resolve()
    if (!running) {
      running = fetchThread(id).finally(() => { running = null })
      return running
    }
    pendingId = id
    if (!pendingPromise) {
      pendingPromise = running.catch(() => {}).then(() => {
        const next = pendingId as string
        pendingId = null
        pendingPromise = null
        return refresh(next)
      })
    }
    return pendingPromise
  }

  /** 订阅这条会话。行推送触发重新拉取，broadcast 只用来传打字状态。 */
  function subscribe(sessionId: string) {
    unsubscribe()
    activeId = sessionId
    if (!supabase) return
    const scheduleRefresh = () => {
      if (refreshTimer || activeId !== sessionId) return
      // Coalesce message, session and read-marker events into one API fetch.
      refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(sessionId) }, 120)
    }
    channel = supabase.channel(`cs:${sessionId}`, { config: { broadcast: { self: false } } })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'cs_messages', filter: `session_id=eq.${sessionId}` },
        (payload: any) => {
          if (activeId !== sessionId || disposed) return
          const row = payload.new
          if (payload.eventType === 'INSERT' && row?.session_id === sessionId && capabilities.value?.can_see &&
              (row.visible_to_user === true || capabilities.value?.can_see_revisions)) {
            // INSERT has no revisions. RLS authenticates the feed; use the same presenter as the API.
            // UPDATE still re-fetches: edited/recalled originals are staff-only, not broadcast data.
            const message = presentMessage(row, { userId: auth.user.value?.id, group: auth.group.value }, null) as CsMessage
            outbox.set(message.id, message)
            messages.value = [...messages.value.filter(m => m.id !== message.id), message]
          }
          if (payload.eventType === 'UPDATE' || payload.eventType === 'DELETE') outbox.delete(row?.id || payload.old?.id)
          scheduleRefresh()
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'cs_sessions', filter: `id=eq.${sessionId}` },
        scheduleRefresh)
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
      .subscribe((status: string) => {
        if (activeId !== sessionId) return
        realtimeReady = status === 'SUBSCRIBED'
        if (realtimeReady) scheduleRefresh()
        poll()
      })
    function poll() {
      clearTimeout(fallbackTimer)
      fallbackTimer = setTimeout(() => {
        if (activeId !== sessionId || disposed) return
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') void refresh(sessionId)
        poll()
      }, realtimeReady ? 30000 : 3000)
    }
    poll()
    if (typeof window !== 'undefined') {
      window.addEventListener('online', resume)
      document.addEventListener('visibilitychange', resume)
    }
  }

  function resume() {
    if (document.visibilityState === 'visible') void refresh()
  }

  function unsubscribe() {
    if (channel && supabase) supabase.removeChannel(channel)
    channel = null
    activeId = null
    realtimeReady = false
    clearTimeout(refreshTimer); refreshTimer = undefined
    clearTimeout(fallbackTimer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
    clearTimeout(peerTimer)
    peerTyping.value = false
  }

  /** 切到另一条会话（工作台点列表）或第一次进入。 */
  async function attach(sessionId: string) {
    unsubscribe()
    activeId = sessionId
    loading.value = true
    pending.value = []
    messages.value = []
    try {
      await refresh(sessionId)
      if (activeId !== sessionId || disposed) return
      subscribe(sessionId)
      if (capabilities.value?.can_see) markRead().catch(() => {})
    } finally {
      if (activeId === sessionId) loading.value = false
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
      if (disposed) return data
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
    if (!session.value || sending.value) return
    const sessionId = session.value.id
    const text = String(body ?? '')
    if (!text.trim() && pending.value.length === 0) return
    sending.value = true
    error.value = ''
    const localId = crypto.randomUUID()
    const attachments = [...pending.value]
    const optimistic: CsMessage = {
      id: localId, session_id: sessionId, sender_id: auth.user.value?.id || null,
      sender_role: isOwner.value ? 'user' : 'agent', body: text, format, attachments,
      auto_reply: false, recalled: false, recalled_at: null, edited_at: null, edit_count: 0,
      created_at: new Date().toISOString(), delivery: 'sending'
    }
    outbox.set(localId, optimistic)
    messages.value = [...messages.value, optimistic]
    try {
      const data = await csApi('/api/cs-message', {
        method: 'POST',
        body: JSON.stringify({
          action: 'send', session_id: sessionId,
          body: text, format, attachments, client_message_id: localId
        })
      })
      outbox.delete(localId)
      if (sessionId !== activeId || disposed) return data
      pending.value = pending.value.filter(a => !attachments.some(sent => sent.path === a.path))
      // 乐观追加自己那条就够了。这里不再 await 第二次 refresh：那一次拉的是自动回复和服务端时间戳，
      // 而 cs_messages 的 Realtime 推送本来就会触发同一个 refresh。await 它的唯一效果是
      // 「发送中」按钮多按一整个往返才松开——消息早已经在列表里了。
      const received = [data.message, data.auto_reply].filter(Boolean)
      for (const message of received) outbox.set(message.id, message)
      const ids = new Set([localId, ...received.map(m => m.id)])
      messages.value = [...messages.value.filter(m => !ids.has(m.id)), ...received]
      refresh().catch(() => {})
      return data
    } catch (e: any) {
      const committed = messages.value.find(m => m.id === localId && !m.delivery)
      if (committed && sessionId === activeId && !disposed) {
        pending.value = pending.value.filter(a => !attachments.some(sent => sent.path === a.path))
        return { message: committed }
      }
      outbox.delete(localId)
      if (sessionId === activeId && !disposed) {
        messages.value = messages.value.filter(m => m.id !== localId)
        error.value = e.message
      }
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

  /**
   * 附件的可下载地址。桶是私有的，所以要签一个短时效的 URL。
   *
   * 一次签一批而不是一个一个签：一条消息带十张图时，逐个签是十次往返，而且每张图都要等自己那次
   * 回来才开始下载，看起来就是「图片加载很慢」。签好的地址缓存到快过期为止，重新拉一遍消息
   * （撤回、编辑、对方发言都会触发）不再重签已经有的那些。
   */
  async function signedUrls(paths: string[], seconds = 900): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    const now = Date.now()
    const missing: string[] = []
    for (const p of paths) {
      if (!p) continue
      const hit = urlCache.get(p)
      if (hit && hit.expires > now) out[p] = hit.url
      else if (!missing.includes(p)) missing.push(p)
    }
    if (!missing.length || !supabase) return out
    const { data } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrls(missing, seconds)
    for (const row of (data || []) as Array<{ path?: string | null; signedUrl?: string | null }>) {
      if (!row?.path || !row.signedUrl) continue
      // 提前 60 秒作废，免得正好在过期那一刻点下载。
      urlCache.set(row.path, { url: row.signedUrl, expires: now + Math.max(seconds - 60, 30) * 1000 })
      out[row.path] = row.signedUrl
    }
    return out
  }

  async function signedUrl(path: string, seconds = 900) {
    const map = await signedUrls([path], seconds)
    return map[path] || ''
  }

  /** 会话结束后用户给客服打分（0~5），只能打一次。 */
  async function rate(score: number, comment = '') {
    if (!session.value) return
    const data = await csApi('/api/cs-session', {
      method: 'POST',
      body: JSON.stringify({ action: 'rate', session_id: session.value.id, rating: score, comment })
    })
    if (data.session) session.value = data.session
    if (data.capabilities) capabilities.value = data.capabilities
    return data
  }

  onScopeDispose(() => { disposed = true; outbox.clear(); unsubscribe() })

  return {
    session, capabilities, messages, config, loading, sending, error, peerTyping,
    uploading, pending, closed, canPost, isOwner,
    attach, open, refresh, send, recall, edit, markRead, notifyTyping, rate,
    upload, dropPending, signedUrl, signedUrls, subscribe, unsubscribe
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
  if (message.delivery) return false
  if (!userId || message.sender_id !== userId) return false
  if (message.recalled || message.auto_reply) return false
  if (message.sender_role === 'system') return false
  const age = Date.now() - new Date(message.created_at).getTime()
  return Number.isFinite(age) && age <= windowMs
}

export { sessionCapabilities }
export type { Ref }
