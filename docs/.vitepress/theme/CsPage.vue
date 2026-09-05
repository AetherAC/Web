<script setup lang="ts">
/**
 * §2.2 客服工作台。需求里的「两个页面」在这里是同一个页面的两个标签——待接入和我的会话，
 * 因为客服的实际动作是在两者之间来回切，切页面会把正在打的字丢掉。
 *
 * 管理员多两个标签：全部会话（§2.10 的介入入口）和看板（§2.13）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  BarChart3, CircleDot, Coins, EyeOff, Gift, Inbox, ListChecks, Radio,
  RefreshCw, ShieldAlert, Star, Users, Wallet, X
} from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import CsThread from './CsThread.vue'
import { supabase, useAuth } from './auth'
import { csApi, csTime, useCsPresence, useCsThread } from './cs'
import { ADMIN_MODES, ADMIN_MODE_LABEL } from '../../../shared/cs.mjs'
import { orderPath } from './routes'

const auth = useAuth()
const thread = useCsThread()
let listRealtimeReady = false
const presence = useCsPresence()

type Tab = 'queue' | 'mine' | 'all' | 'agents' | 'dashboard'
const tab = ref<Tab>('queue')
const sessions = ref<any[]>([])
const agents = ref<any[]>([])
const onlineCount = ref(0)
const board = ref<any>(null)
const boardDays = ref(30)
const active = ref<string | null>(null)
const message = ref('')
const loading = ref(false)
const includeClosed = ref(false)
const filters = ref<{ channel: string; status: string; unassigned: boolean; excludeMine: boolean }>(
  { channel: '', status: 'open', unassigned: false, excludeMine: false })

/** 侧栏的动作面板：券、退款、订单。三者都在 cs-actions 上。 */
const orders = ref<any[]>([])
const coupon = ref({ template_id: '', note: '' })
const refund = ref({ amount: '', reason: '' })
const panel = ref<'' | 'coupon' | 'refund' | 'orders'>('')

const tabs = computed(() => [
  { id: 'queue' as Tab, label: '待接入', icon: Inbox },
  { id: 'mine' as Tab, label: '我的会话', icon: ListChecks },
  ...(auth.isAdmin.value
    ? [
      { id: 'all' as Tab, label: '全部会话', icon: Radio },
      { id: 'agents' as Tab, label: '客服在线', icon: Users },
      { id: 'dashboard' as Tab, label: '响应看板', icon: BarChart3 }
    ]
    : [{ id: 'agents' as Tab, label: '我的状态', icon: Users }])
])

const CHANNEL_LABEL: Record<string, string> = { presale: '售前', postsale: '售后' }
// 介入模式的中文名从 shared/cs.mjs 来，不在这里再抄一份：抄一份的下场就是上一版——那里已经只剩
// normal/blind 两种，这里还画着四个按钮，其中两个点下去必然被接口 400。
const MODE_LABEL: Record<string, string> = ADMIN_MODE_LABEL

const current = computed(() => sessions.value.find(s => s.id === active.value) || null)
const caps = computed(() => thread.capabilities.value)
// §2.10 的介入现在只决定管理员署谁的名，不再有「只读」这一档，所以工作台里也没有「看得到发不了」
// 这个状态了。介入过的痕迹看 admin_id：blind 是每个会话的默认值，按 admin_mode 判会给每一行都挂上标签。
const intervened = computed(() => Boolean(thread.session.value?.admin_id))

/**
 * 介入模式那一排按钮出不出来。
 *
 * 三个条件缺一不可：
 *   - 是管理员。介入是 §2.10 的管理员动作，客服看到这排按钮只会点出 403。
 *   - 停在「全部会话」页。「待接入」和「我的会话」这两页是管理员当客服用的——在那里他是接待人本身，
 *     介入的对象是别人的会话，不是自己正在接的这条。
 *   - 这条会话不在自己手上。分给自己的会话里「以谁的名义说话」没有第二种答案：署名只能是他自己，
 *     切 normal/blind 不改变任何东西，留着按钮反而让人以为切过去会有区别。
 */
const canIntervene = computed(() => auth.isAdmin.value && tab.value === 'all' &&
  Boolean(thread.session.value) && thread.session.value.agent_id !== auth.user.value?.id)

async function load() {
  loading.value = true
  message.value = ''
  try {
    if (tab.value === 'dashboard') {
      board.value = await csApi(`/api/cs-workbench?view=dashboard&days=${boardDays.value}`)
      return
    }
    if (tab.value === 'agents') {
      const data = await csApi('/api/cs-workbench?view=agents')
      agents.value = data.agents || []
      onlineCount.value = data.online_count || 0
      const me = agents.value.find(a => a.user_id === auth.user.value?.id)
      if (me) {
        presence.online.value = me.online === true
        presence.note.value = me.status_note || ''
        presence.maxConcurrent.value = me.max_concurrent ?? null
      }
      return
    }
    const params = new URLSearchParams({ view: tab.value })
    if (tab.value === 'mine' && includeClosed.value) params.set('include_closed', '1')
    if (tab.value === 'all') {
      if (filters.value.channel) params.set('channel', filters.value.channel)
      if (filters.value.status) params.set('status', filters.value.status)
      if (filters.value.unassigned) params.set('unassigned', '1')
      // 「排除我的」。自己手上的会话在「我的会话」页已经有一份，管理员翻这一页找的是别人的。
      // 服务端用 or(agent_id.is.null, agent_id.neq.我) 实现（见 cs-workbench 的 listAll）：单个 neq
      // 会把 agent_id 为空的待接入会话一起筛掉，而那些恰好是这一页最需要看到的。
      if (filters.value.excludeMine) params.set('exclude_mine', '1')
    }
    const data = await csApi(`/api/cs-workbench?${params}`)
    sessions.value = data.sessions || []
    // 当前打开的会话不在新列表里了（被别人接走、或者筛掉了）就收起右侧。站内信点进来的那条例外：
    // 它本来就常常不在「我的」标签里（已关闭、或者分给别人），一收就等于那个链接只能看 20 秒。
    if (active.value && active.value !== deepLinked.value &&
      !sessions.value.some(s => s.id === active.value)) active.value = null
  } catch (e: any) {
    message.value = e.message
  } finally {
    loading.value = false
  }
}

async function pick(row: any) {
  active.value = row.id
  panel.value = ''
  orders.value = []
  await thread.attach(row.id)
}

/** 站内信深链进来的那条会话 id。见 openFromQuery 与 load() 里那条例外。 */
const deepLinked = ref('')

/** §2.12 接入。抢不到（别人先点了）时服务端回 409，刷一次列表就看得到是谁接的。 */
async function claim(row: any) {
  try {
    await csApi('/api/cs-session', {
      method: 'POST', body: JSON.stringify({ action: 'claim', session_id: row.id })
    })
    message.value = '已接入该会话'
    tab.value = 'mine'
    await load()
    await pick(row)
  } catch (e: any) {
    message.value = e.message
    await load()
  }
}

async function close(row: any) {
  if (!confirm('关闭这条会话？用户仍可以重新发起。')) return
  try {
    await csApi('/api/cs-session', {
      method: 'POST', body: JSON.stringify({ action: 'close', session_id: row.id, reason: 'agent' })
    })
    await load()
    if (active.value === row.id) await thread.refresh()
  } catch (e: any) { message.value = e.message }
}

/** §2.10 两种介入模式。切换只改管理员发言时署谁的名，不影响客服能不能看到这条会话。 */
async function setMode(mode: string) {
  if (!thread.session.value) return
  try {
    const data = await csApi('/api/cs-session', {
      method: 'POST',
      body: JSON.stringify({ action: 'admin_mode', session_id: thread.session.value.id, admin_mode: mode })
    })
    thread.session.value = data.session
    message.value = `介入模式：${MODE_LABEL[mode] || mode}`
    await thread.refresh()
  } catch (e: any) { message.value = e.message }
}

/** §2.7 在会话里发一张券。 */
async function sendCoupon() {
  if (!thread.session.value) return
  try {
    const data = await csApi('/api/cs-actions', {
      method: 'POST',
      body: JSON.stringify({
        action: 'send_coupon', session_id: thread.session.value.id,
        template_id: coupon.value.template_id, note: coupon.value.note
      })
    })
    message.value = `已发出优惠券 ${data.code}`
    coupon.value = { template_id: '', note: '' }
    panel.value = ''
    await thread.refresh()
  } catch (e: any) { message.value = e.message }
}

/** §2.8 / §10.1 在会话里发起退款。批准是管理员的事，这里只是提交申请。 */
async function startRefund() {
  if (!thread.session.value) return
  try {
    const data = await csApi('/api/cs-actions', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start_refund', session_id: thread.session.value.id,
        amount_minor: refund.value.amount ? Math.round(Number(refund.value.amount) * 100) : undefined,
        reason: refund.value.reason
      })
    })
    message.value = `退款申请已提交，已通知 ${data.notified} 位管理员审批`
    refund.value = { amount: '', reason: '' }
    panel.value = ''
    await thread.refresh()
  } catch (e: any) { message.value = e.message }
}

/**
 * §5 会话侧栏里的订单信息。
 *
 * 和优惠券、退款一样是个 toggle：三个按钮长在同一排、面板长在同一个位置，其中两个能点第二次收起、
 * 第三个不能，那不是三个按钮而是两种按钮。再点一次就收起，收起时不再请求。
 */
async function toggleOrders() {
  if (!thread.session.value) return
  if (panel.value === 'orders') { panel.value = ''; return }
  panel.value = 'orders'
  // 已经取过就不再取：切走再切回来时那份数据没有过期的理由，而每次都取的表现是面板闪一下空白。
  if (orders.value.length) return
  try {
    const data = await csApi('/api/cs-actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'orders', session_id: thread.session.value.id })
    })
    orders.value = data.orders || []
  } catch (e: any) { message.value = e.message }
}

const money = (minor: number, currency = 'CNY') =>
  `${currency} ${((Number(minor) || 0) / 100).toFixed(2)}`
const pct = (n: number) => `${Math.round((Number(n) || 0) * 1000) / 10}%`
const secs = (n: number | null) => (n === null || n === undefined ? '—' : n < 60 ? `${n} 秒` : `${Math.round(n / 60)} 分钟`)

async function selectTab(id: Tab) { tab.value = id; active.value = null; await load() }

watch(() => auth.ready.value, async ready => {
  if (!ready) return
  if (!auth.user.value) { auth.requireUser('/cs'); return }
  if (!auth.isStaff.value) return
  presence.start()
  await load()
  await openFromQuery()
  // 订阅放在登录确认之后：Realtime 带的是当前的 access token，没登录时订上去的频道会被 RLS 拒掉，
  // 而被拒的频道不会自己重试。
  subscribeList()
}, { immediate: true })

/**
 * §9.4 站内信里的「打开会话」落在这里：/cs?session=<uuid>。
 *
 * 不要求那条会话在刚载入的列表里——通知可能指向一条已经关闭的、或者分给别人的会话，而这两种都不在
 * 默认的「我的」标签下。attach 走的是 cs-thread 接口，能不能看仍然由 RLS 说话；列表里没有的那条，
 * 侧栏标题会退回 thread.session 上的 user_id 前八位。
 */
async function openFromQuery() {
  if (typeof window === 'undefined') return
  const id = new URLSearchParams(location.search).get('session')
  if (!id || active.value === id) return
  deepLinked.value = id
  active.value = id
  panel.value = ''
  orders.value = []
  try { await thread.attach(id) } catch (e: any) { message.value = e.message; active.value = null }
}

/**
 * 列表的新鲜度（item 2：客服服务延迟太高）。
 *
 * 原来是一个 20 秒的定时器。它的代价不只是「慢半拍」：一条新会话平均要等十秒才出现在队列里，
 * 而那十秒一秒不少地记进 §2.13 的首响统计——看板上的响应时间里有一段是工作台自己造的。
 *
 * 原来那句注释说「cs_sessions 的 RLS 让客服只看得到分给自己的行，待接入队列里 agent_id 为 null 的
 * 行推不过来」——那是错的。private.can_see_session 里明写着：
 *
 *     or (s.agent_id is null and (select private.serves_channel(s.channel)))
 *
 * 待接入的行本来就对有资格的客服可见，所以它们同样推得过来。改成推送为主、轮询兜底：
 *   - 兜底轮询留着，但放慢到 60 秒，而且只在页面可见时跑。推送会漏（断线重连之间的空窗），
 *     而漏掉的表现是队列里少一条会话、页面上没有任何提示。
 *   - 标签页切回来先刷一次：后台标签的定时器会被浏览器压到分钟级，回来时看到的可能是几分钟前的列表。
 */
let listChannel: any = null
let reloadTimer: any = null
let pollTimer: any = null

/**
 * 把一串推送合并成一次刷新。
 *
 * 关一条会话会同时推 cs_sessions 的 UPDATE 和 cs_messages 的 INSERT（那条系统消息），接一条会话也是两条。
 * 每条都直接 load() 的话，一个动作打两次接口，而两次的结果一样。
 */
function scheduleReload(delay = 500) {
  if (reloadTimer) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    if (!loading.value) load()
  }, delay)
}

/**
 * 订阅列表相关的行变化。
 *
 * 只订阅、不把推来的行拼进 sessions——推过来的是原始数据库行，没有 user_name、没有 last_message，
 * 也没有经过 decorate；拼进去的结果是列表里出现一条没有称呼的会话。推送只当「该刷新了」的信号。
 */
function subscribeList() {
  if (!supabase || listChannel) return
  listChannel = supabase.channel('cs:workbench')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cs_sessions' }, () => scheduleReload())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cs_messages' }, () => scheduleReload())
    .subscribe((status: string) => {
      listRealtimeReady = status === 'SUBSCRIBED'
      if (listRealtimeReady) scheduleReload(0)
    })
}

function onVisibility() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
  scheduleReload(0)
}

onMounted(() => {
  let lastPoll = 0
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    if (!loading.value && Date.now() - lastPoll >= (listRealtimeReady ? 60000 : 5000)) {
      lastPoll = Date.now()
      void load()
    }
  }, 5000)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (reloadTimer) clearTimeout(reloadTimer)
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  if (listChannel && supabase) { supabase.removeChannel(listChannel); listChannel = null }
})
</script>
<template>
<div class="fluent-page admin-page">
  <SiteHeader />
  <main class="admin-shell">
    <aside class="admin-rail">
      <div class="admin-title">
        <span>C</span>
        <div><b>客服工作台</b><small>{{ auth.groupLabel.value }}</small></div>
      </div>

      <div class="cs-presence">
        <button class="cs-toggle" :class="{ on: presence.online.value }" :disabled="presence.busy.value"
          @click="presence.setOnline(!presence.online.value)">
          <CircleDot :size="16" />{{ presence.online.value ? '在线接单' : '已下线' }}
        </button>
        <small v-if="presence.online.value">心跳每 45 秒一次；关掉页面后会被判为掉线</small>
        <small v-else>下线期间不会分到新会话，手上的会话仍然可以回复</small>
      </div>

      <nav>
        <button v-for="item in tabs" :key="item.id" :class="{ active: tab === item.id }" @click="selectTab(item.id)">
          <component :is="item.icon" :size="19" />{{ item.label }}
        </button>
      </nav>
      <a href="/me">返回我的账户</a>
    </aside>

    <section class="admin-workspace">
      <header class="workspace-head">
        <div>
          <p>CUSTOMER SERVICE / {{ tab.toUpperCase() }}</p>
          <h1>{{ tabs.find(x => x.id === tab)?.label }}</h1>
        </div>
        <button class="icon-button" @click="load"><RefreshCw :size="18" /></button>
      </header>

      <div v-if="auth.ready.value && !auth.user.value" class="fluent-empty">正在跳转到登录页…</div>
      <div v-else-if="!auth.isStaff.value" class="fluent-empty">
        <ShieldAlert :size="28" />
        <h2>只有客服与管理员可以使用工作台</h2>
        <p>当前用户组：{{ auth.groupLabel.value }}。需要 presale / postsale / cs / admin 之一。</p>
      </div>

      <!-- §2.13 看板 -->
      <template v-else-if="tab === 'dashboard'">
        <div class="section-toolbar">
          <span>最近 {{ board?.days ?? boardDays }} 天，共 {{ board?.overall?.total ?? 0 }} 条会话</span>
          <span class="toolbar-actions">
            <select v-model.number="boardDays" @change="load">
              <option :value="7">7 天</option><option :value="30">30 天</option><option :value="90">90 天</option>
            </select>
          </span>
        </div>
        <div class="metric-grid">
          <article><span>回复率</span><strong>{{ pct(board?.overall?.reply_rate ?? 0) }}</strong>
            <small>分母是区间内建立的全部会话，含无人接的</small></article>
          <article><span>超时率</span><strong>{{ pct(board?.overall?.timeout_rate ?? 0) }}</strong>
            <small>因无消息被自动关闭的比例</small></article>
          <article><span>首响中位数</span><strong>{{ secs(board?.overall?.median_first_response_seconds ?? null) }}</strong>
            <small>均值 {{ secs(board?.overall?.avg_first_response_seconds ?? null) }}，自动回复不计入</small></article>
        </div>
        <div class="metric-grid">
          <article v-for="(m, ch) in board?.by_channel || {}" :key="ch">
            <span>{{ CHANNEL_LABEL[ch] || ch }}</span><strong>{{ pct(m.reply_rate) }}</strong>
            <small>{{ m.total }} 条 · 超时 {{ pct(m.timeout_rate) }} · 首响 {{ secs(m.median_first_response_seconds) }}</small>
          </article>
          <article><span>当前排队</span><strong>{{ board?.queued_now ?? 0 }}</strong>
            <small>此刻还没人接的会话数</small></article>
        </div>
        <section class="records">
          <div class="section-toolbar"><span>按客服</span></div>
          <article v-for="a in board?.by_agent || []" :key="a.user_id">
            <div><b>{{ a.display_name || a.user_id }}</b>
              <small>{{ a.total }} 条 · 回复率 {{ pct(a.reply_rate) }} · 超时率 {{ pct(a.timeout_rate) }} ·
                首响 {{ secs(a.median_first_response_seconds) }}</small></div>
          </article>
          <p v-if="!board?.by_agent?.length" class="fluent-empty">区间内没有被接入的会话</p>
        </section>
      </template>

      <!-- §2.3 在线名单 -->
      <template v-else-if="tab === 'agents'">
        <div class="section-toolbar">
          <span>{{ agents.length }} 人在册 · {{ onlineCount }} 人可接单</span>
        </div>
        <form class="fluent-notice compact" @submit.prevent="presence.setNote(presence.note.value)">
          <b>我的状态备注</b>
          <label class="field">
            <input v-model="presence.note.value" maxlength="120" placeholder="例如：处理退款中，回复稍慢">
          </label>
          <button class="fluent-secondary" :disabled="presence.busy.value">保存备注</button>
        </form>
        <section class="records">
          <article v-for="a in agents" :key="a.user_id">
            <div>
              <b>{{ a.display_name || a.user_id }}</b>
              <small>
                {{ a.group }} ·
                {{ a.effective_online ? '在线' : (a.heartbeat_stale ? '心跳过期（掉线）' : '已下线') }} ·
                手上 {{ a.load }}/{{ a.max_concurrent }}{{ a.max_concurrent_explicit ? '' : '（默认值）' }}
                <template v-if="a.last_heartbeat"> · 最后心跳 {{ csTime(a.last_heartbeat) }}</template>
                <template v-if="a.status_note"> · {{ a.status_note }}</template>
              </small>
            </div>
          </article>
          <p v-if="!agents.length" class="fluent-empty">还没有客服登记过在线状态</p>
        </section>
        <div class="admin-callout compact">
          <b>在线与掉线是两件事</b>
          <p>手动下线是「我按了下线」，心跳过期是「浏览器被关掉了」。分配会话只看两者都通过的人，
            所以一个 <code>online</code> 还是 true 但心跳已经过期的账号不会再分到新会话。</p>
        </div>
      </template>

      <!-- 队列 / 我的 / 全部：左列表右会话 -->
      <div v-else class="cs-workbench">
        <section class="records cs-list">
          <div class="section-toolbar">
            <span>{{ sessions.length }} 条会话</span>
            <span class="toolbar-actions">
              <label v-if="tab === 'mine'" class="check-label">
                <input v-model="includeClosed" type="checkbox" @change="load">含已关闭
              </label>
              <template v-if="tab === 'all'">
                <select v-model="filters.channel" @change="load">
                  <option value="">全部渠道</option><option value="presale">售前</option><option value="postsale">售后</option>
                </select>
                <select v-model="filters.status" @change="load">
                  <option value="open">进行中</option><option value="closed">已关闭</option><option value="">全部</option>
                </select>
                <label class="check-label"><input v-model="filters.unassigned" type="checkbox" @change="load">仅无人接</label>
                <!-- 「排除我的」：自己手上那些在「我的会话」页已经有一份，这一页找的是别人的。 -->
                <label class="check-label"><input v-model="filters.excludeMine" type="checkbox" @change="load">排除我的</label>
              </template>
            </span>
          </div>

          <p v-if="loading && !sessions.length" class="fluent-empty">加载中…</p>
          <p v-else-if="!sessions.length" class="fluent-empty">
            {{ tab === 'queue' ? '队列是空的，没有等待接入的会话' : '这里还没有会话' }}
          </p>

          <article v-for="row in sessions" :key="row.id" :class="{ selected: active === row.id }" @click="pick(row)">
            <div>
              <b>
                {{ row.user_name || row.user_id.slice(0, 8) }}
                <em class="cs-tag">{{ CHANNEL_LABEL[row.channel] || row.channel }}</em>
                <em v-if="row.unread_from_user" class="cs-tag unread">{{ row.unread_from_user }} 条未读</em>
                <em v-if="row.admin_id" class="cs-tag mode">{{ MODE_LABEL[row.admin_mode] || row.admin_mode }}</em>
                <em v-if="row.rated_at" class="cs-tag rating">{{ row.rating }} 分</em>
              </b>
              <small>
                {{ row.last_message?.body || '（还没有消息）' }}
              </small>
              <small class="cs-meta">
                {{ csTime(row.last_activity_at || row.created_at) }}
                <template v-if="row.agent_name"> · {{ row.agent_name }}</template>
                <template v-else-if="row.status === 'open'"> · 等待接入</template>
                <template v-if="row.order_id"> · 订单 {{ row.order_id.slice(0, 8) }}</template>
                <template v-if="row.status !== 'open'"> · 已关闭{{ row.timed_out ? '（超时）' : '' }}</template>
              </small>
            </div>
            <button v-if="tab !== 'mine' && row.status === 'open' && !row.agent_id" class="fluent-primary cs-claim"
              @click.stop="claim(row)">接入</button>
            <button v-else-if="row.status === 'open' && row.agent_id === auth.user.value?.id" title="关闭会话"
              @click.stop="close(row)"><X :size="16" /></button>
          </article>
        </section>

        <section v-if="active && thread.session.value" class="cs-detail">
          <header class="cs-detail-head">
            <div>
              <p class="eyebrow">
                {{ CHANNEL_LABEL[thread.session.value.channel] }} ·
                {{ current?.user_name || thread.session.value.user_id.slice(0, 8) }}
              </p>
              <h2>
                {{ thread.session.value.status === 'open' ? '进行中' : '已关闭' }}
                <small v-if="thread.session.value.first_response_seconds !== null">
                  首响 {{ secs(thread.session.value.first_response_seconds) }}
                </small>
              </h2>
            </div>
            <div class="cs-detail-actions">
              <button title="订单信息" :class="{ on: panel === 'orders' }" @click="toggleOrders"><Wallet :size="17" /></button>
              <button title="发优惠券" :class="{ on: panel === 'coupon' }"
                @click="panel = panel === 'coupon' ? '' : 'coupon'"><Gift :size="17" /></button>
              <button v-if="thread.session.value.order_id || auth.isAdmin.value" title="发起退款"
                :class="{ on: panel === 'refund' }"
                @click="panel = panel === 'refund' ? '' : 'refund'"><Coins :size="17" /></button>
            </div>
          </header>

          <!-- §2.10 管理员介入模式。只在「全部会话」里、且这条会话不在自己手上时才出现，见 canIntervene。 -->
          <div v-if="canIntervene" class="cs-modes">
            <span>介入模式</span>
            <button v-for="m in ADMIN_MODES" :key="m"
              :class="{ on: intervened && thread.session.value.admin_mode === m }" @click="setMode(m)">
              <component :is="m === 'blind' ? EyeOff : Radio" :size="15" />
              {{ MODE_LABEL[m] }}
            </button>
            <small>
              两种模式都不影响谁看得见这条会话，差别只有一处：正常介入时你说的话署接待客服的名，
              用户看到的还是同一个人在回；管理员介入时署你自己的名。真实作者两种情况下都记在审计里。
              <template v-if="!intervened">还没有人介入过这条会话。</template>
            </small>
          </div>

          <!-- §2.14 用户给这次服务打的分。只在会话关闭且用户评过之后才有。 -->
          <p v-if="thread.session.value.rated_at" class="cs-rating-view">
            <Star :size="15" />
            用户评分 {{ thread.session.value.rating }} / 5
            <template v-if="thread.session.value.rating_comment">· {{ thread.session.value.rating_comment }}</template>
          </p>

          <form v-if="panel === 'coupon'" class="cs-action-form" @submit.prevent="sendCoupon">
            <label class="field"><span>券模板 ID</span>
              <input v-model="coupon.template_id" required placeholder="coupon_templates 里的 id">
            </label>
            <label class="field"><span>附言（可选）</span>
              <input v-model="coupon.note" maxlength="200" placeholder="随券发给用户的一句话">
            </label>
            <button class="fluent-primary"><Gift :size="16" />生成并发送</button>
          </form>

          <form v-if="panel === 'refund'" class="cs-action-form" @submit.prevent="startRefund">
            <label class="field"><span>退款金额（留空为全额）</span>
              <input v-model="refund.amount" type="number" step="0.01" min="0" placeholder="按元填，例如 39.90">
            </label>
            <label class="field"><span>原因</span>
              <input v-model="refund.reason" required maxlength="500" placeholder="写清楚，管理员按这段话审批">
            </label>
            <button class="fluent-primary"><Coins :size="16" />提交退款申请</button>
            <small>提交后会给所有管理员发站内信；48 小时未处理会再提醒一次。批准与执行不在客服权限内。</small>
          </form>

          <div v-if="panel === 'orders'" class="cs-orders">
            <p v-if="!orders.length" class="fluent-empty">这位用户名下没有订单</p>
            <a v-for="o in orders" :key="o.id" class="order-row" :href="orderPath(o.id)" target="_blank" rel="noopener">
              <div><b>{{ o.sku_name || o.sku }}</b>
                <small>{{ o.status }} · {{ money(o.paid_amount_minor || o.amount_minor, o.paid_currency || o.currency) }}
                  · {{ o.provider || '—' }} · {{ csTime(o.paid_at || o.created_at) }}</small></div>
            </a>
          </div>

          <CsThread :thread="thread" staff placeholder="回复用户…" />
        </section>
        <div v-else-if="sessions.length" class="fluent-empty cs-detail-empty">
          <Inbox :size="28" /><h2>选择一条会话</h2>
          <p>左侧点一条会话开始回复。待接入的会话要先点「接入」才能发言。</p>
        </div>
      </div>

      <p class="admin-message">{{ message }}</p>
    </section>
  </main>
</div>
</template>
