<script setup lang="ts">
/**
 * §9 站内信收件箱。
 *
 * 这一页没有输入框，一个都没有：站内信是单向的（§9 原文「不可回复，属于单向信息传递」）。加一个
 * 「回复」按钮很自然，但结果是用户在一个不会有人看的地方提问题。要说话的入口是 §2 的客服挂件。
 *
 * 已读有两条路（§9.7）：点开算，停留够久也算。停留多久由服务端给（read_dwell_ms），不写死 2000——
 * 写死的话管理员把它改成 5 秒，页面照旧 2 秒，而配置页会显示保存成功。
 *
 * 审批按钮就在通知里（§9.4/§10.4）：一条待审批的退款自带批准/拒绝/转交。按钮显示与否走 canUseAction，
 * 真正的判定在三个接口的 requireUser(admin) 上——前端隐藏只是别给人看一个点了必然 403 的按钮。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Archive, ArchiveRestore, Bell, CheckCheck, ExternalLink, Gavel, Headset, Inbox,
  Pin, ReceiptText, RefreshCw, RotateCcw, ShieldAlert, Ticket
} from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'
import { useAuth } from './auth'
import { preloadMarkdown, renderRichBody } from './markdown'
import { inboxApi, loadInboxSettings, refreshBadge, useInboxBadge, type InboxSettings } from './inbox'
import { orderPath } from './routes'
import {
  ACTION_ENDPOINT, KIND_LABEL, SCOPE_LABEL, STATE_LABEL,
  canUseAction, needsConfirm, needsReason
} from '../../../shared/notifications.mjs'

const auth = useAuth()
const badge = useInboxBadge()

const items = ref<any[]>([])
const loading = ref(true)
const paging = ref(false)
/** 正在处理的通知 id。只禁用那一条上的按钮，别把整页锁住。 */
const busy = ref('')
const message = ref('')
const showArchived = ref(false)
const hasMore = ref(false)
const nextBefore = ref<string | null>(null)
const settings = ref<InboxSettings>({
  auto_archive_days: 30, read_dwell_ms: 2000, notify_browser: true, notify_email: false
})
/** 转交/拒绝要填的东西。一次只开一个表单：两条通知的理由框同时开着，很容易填到另一条上。 */
const form = ref<{ id: string; type: string; target: string; label: string } | null>(null)
const formNote = ref('')
const formTo = ref('')
const admins = ref<any[]>([])
const KIND_ICON: Record<string, any> = {
  system: Bell, admin: ShieldAlert, order: ReceiptText, refund: RotateCcw,
  refund_approval: Gavel, session: Headset, ticket: Ticket
}

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '')
const kindLabel = (k: string) => KIND_LABEL[k] || k
const scopeLabel = (s: string) => SCOPE_LABEL[s] || s
const stateLabel = (s?: string | null) => (s ? STATE_LABEL[s] || s : '')
const bodyHtml = (n: any) => renderRichBody(n.body, n.format)
const relatedOrder = (n: any) => (n.order_id ? orderPath(n.order_id) : '')

const unreadOnPage = computed(() => items.value.filter(n => !n.read).map(n => n.id))

/**
 * 拉一页。limit 取 50 而不是接口默认的 20：接口的 has_more 是按「查出来多少行」算的，归档过滤发生在
 * 那之后，所以一页全是另一侧（归档/未归档）时 items 会是空的。页大一点让这种空页少得多。
 */
async function load(append = false) {
  if (append) paging.value = true
  else loading.value = true
  message.value = ''
  try {
    const params = new URLSearchParams({ limit: '50' })
    if (showArchived.value) params.set('archived', 'true')
    if (append && nextBefore.value) params.set('before', nextBefore.value)
    const { ok, data } = await inboxApi(`/api/notifications?${params}`)
    if (!ok) { message.value = data.error || '读取站内信失败'; return }
    const rows = data.items || []
    items.value = append ? [...items.value, ...rows] : rows
    // next_before 取自过滤后的 items，所以整页都被过滤掉时它是 null。那种情况下没有游标能往下翻，
    // 再点一次只会拿回同一页——所以直接收起按钮，而不是留一个点了不动的「载入更多」。
    nextBefore.value = data.next_before ?? null
    hasMore.value = data.has_more === true && Boolean(data.next_before)
  } finally {
    loading.value = false
    paging.value = false
  }
}
/**
 * 标已读。dwell_ms 记的是走了哪条路：0 是点开的，>0 是停留满了的。接口把它存进 receipt，
 * §9.7 那条配置将来要调成多少，靠的就是这一列。
 */
async function markRead(ids: string[], dwellMs: number) {
  const wanted = ids.filter(id => items.value.some(n => n.id === id && !n.read))
  if (!wanted.length) return
  // 先在本地标掉：失败了下一次 load 会恢复原状，而乐观更新省掉的是「点开一条通知，未读点还亮着
  // 半秒」这种看起来像没生效的延迟。
  items.value = items.value.map(n => (wanted.includes(n.id) ? { ...n, read: true } : n))
  badge.decrementUnread(wanted.length)
  const { ok, data } = await inboxApi('/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ action: 'read', ids: wanted, dwell_ms: Math.round(dwellMs) })
  })
  if (!ok) {
    message.value = data.error || '标记已读失败'
    await load()
    await refreshBadge()
  }
}

const dwellTimers = new Map<string, any>()
let observer: IntersectionObserver | null = null

function stopDwell(id: string) {
  const timer = dwellTimers.get(id)
  if (timer) { clearTimeout(timer); dwellTimers.delete(id) }
}

/**
 * §9.7 的「停留算已读」。计时器只挂在元素可见的那段时间上，滚走就取消——滑过去半秒不算读过。
 * 用 IntersectionObserver 而不是滚动事件：后者要自己算每一条的位置，那份计算在一个会追加的列表里
 * 随时会错。
 */
function startDwell(id: string) {
  if (dwellTimers.has(id)) return
  const wait = Math.max(0, Number(settings.value.read_dwell_ms) || 0)
  dwellTimers.set(id, setTimeout(() => {
    dwellTimers.delete(id)
    void markRead([id], wait)
  }, wait))
}

function bindItem(id: string, el: any) {
  if (!observer || !(el instanceof Element)) return
  ;(el as HTMLElement).dataset.nid = id
  observer.observe(el)
}
onMounted(() => {
  // SSR 阶段没有 IntersectionObserver。没有它也只是少一条已读路径，点开那条仍然有效。
  if (typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.nid
      if (!id) continue
      const row = items.value.find(n => n.id === id)
      if (!row || row.read) { stopDwell(id); continue }
      if (entry.isIntersecting) startDwell(id)
      else stopDwell(id)
    }
  }, { threshold: 0.6 })
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
  for (const timer of dwellTimers.values()) clearTimeout(timer)
  dwellTimers.clear()
})

/**
 * §9.8 手动归档，以及撤销。
 *
 * 待处理的归档不掉：接口回 409，正文里带着有几条被挡住。这里把那句话原样显示——§9.6 要求待审批一直
 * 挡在眼前，而归档正好是让它不挡在眼前，所以这不是一个能放宽的限制。
 */
async function toggleArchive(n: any) {
  busy.value = n.id
  try {
    const undo = Boolean(n.archived)
    const { ok, data } = await inboxApi('/api/notifications', {
      method: 'POST', body: JSON.stringify({ action: 'archive', ids: [n.id], undo })
    })
    if (!ok) { message.value = data.error || (undo ? '取消归档失败' : '归档失败'); return }
    message.value = undo ? '已移回收件箱' : '已归档'
    // 归档过的那条不属于当前这一侧了，本地摘掉比重读整页快，也不会把滚动位置弹回顶部。
    items.value = items.value.filter(x => x.id !== n.id)
    await refreshBadge()
  } finally {
    busy.value = ''
  }
}

async function markAllRead() {
  const ids = unreadOnPage.value
  if (!ids.length) return
  // 只标已经载入的这些。接口一次最多收 100 条，而「全部」是个没有上限的集合。
  const batch = ids.slice(0, 100)
  await markRead(batch, 0)
  message.value = `已标记 ${batch.length} 条为已读`
}
/**
 * 转交要选人。点了转交才拉这份名单：绝大多数人打开收件箱是来看通知的，不该为此顺带拉一遍用户表。
 * 只留 admin——refund-transfer.mjs 的 REFUND_APPROVER_GROUPS 就只有 admin，选到别人是必然的 400。
 * 也去掉自己：那个接口对自转交有一句专门的拒绝。
 */
async function loadAdmins() {
  if (admins.value.length) return
  const { ok, data } = await inboxApi('/api/admin-users')
  if (!ok) { message.value = data.error || '读取管理员名单失败'; return }
  admins.value = (data.users || []).filter((u: any) =>
    u.group_name === 'admin' && u.user_id !== auth.user.value?.id)
}

function openForm(n: any, action: any) {
  form.value = { id: n.id, type: action.type, target: action.target, label: action.label }
  formNote.value = ''
  formTo.value = ''
  if (action.type === 'transfer_refund') void loadAdmins()
}

/**
 * 点一个动作按钮。
 *
 * link 只是个链接，mark_read 走已读接口，open_session 是跳转，剩下三个是退款决定。这四类的差别不只
 * 是终点不同：要不要理由、要不要二次确认、谁能点，三件事都不一样，所以不拿一个通用的「提交动作」
 * 把它们抹平。
 */
async function runAction(n: any, action: any, extra: Record<string, any> = {}) {
  if (action.type === 'link') return
  if (action.type === 'mark_read') { await markRead([n.id], 0); return }
  if (action.type === 'open_session') { gotoSession(n, action); return }

  const endpoint = ACTION_ENDPOINT[action.type]
  if (!endpoint) { message.value = `这条通知带了一个本站不认识的动作：${action.type}`; return }
  if (needsReason(action.type) && !String(extra.note || '').trim()) {
    message.value = '这一步必须写清楚原因'
    return
  }
  // §13.4 的二次确认。批准一旦发出就进了退款流程，没有对应的撤销动作（IRREVERSIBLE_ACTIONS）。
  if (needsConfirm(action.type) &&
    !confirm(`${action.label}这笔退款？\n\n批准之后款项就进入退款流程，这一步没有撤销。`)) return
  busy.value = n.id
  try {
    const body: Record<string, any> = { refund_id: action.target, ...extra }
    // §14 的 refund_require_second_confirm 关掉时接口不查这一位，带着也无害；开着时缺它就是 428。
    // 与其按配置分两条路，不如浏览器确认过就一定带上——两种配置下行为一样。
    if (needsConfirm(action.type)) body.confirm = true
    const { ok, status, data } = await inboxApi(endpoint, { method: 'POST', body: JSON.stringify(body) })
    if (!ok) {
      message.value = status === 428
        ? '这一步需要二次确认，请刷新页面后重试'
        : (data.error || `操作失败（${status}）`)
      return
    }
    message.value = data.message || `${action.label}已完成`
    form.value = null
    // 处理完之后服务端会把这条的 state 落定、置顶随之解除，还会给申请人补一条新通知。那些都不在
    // 本地能算出来，所以整页重读。
    await load()
    await refreshBadge()
  } finally {
    busy.value = ''
  }
}

async function submitForm() {
  const current = form.value
  if (!current) return
  const row = items.value.find(n => n.id === current.id)
  if (!row) { form.value = null; return }
  const extra: Record<string, any> = { note: formNote.value.trim() }
  if (current.type === 'transfer_refund') {
    if (!formTo.value) { message.value = '请选择要转交给谁'; return }
    extra.transfer_to = formTo.value
  }
  await runAction(row, { type: current.type, target: current.target, label: current.label }, extra)
}

/**
 * open_session：客服和管理员去工作台，普通用户回订单页。
 *
 * 用户这一侧不是退让——/cs 是工作台，普通用户进去只会看到一句「只有客服与管理员可以使用」。而订单页上
 * 的挂件本来就会自己探到那条开着的会话（CsWidget 的 probe），带着订单号回去正好落在它上面；没有订单号
 * 的是售前会话，首页的挂件同样探得到。
 */
function gotoSession(n: any, action: any) {
  if (auth.isStaff.value) {
    location.href = `/cs?session=${encodeURIComponent(action.target || n.session_id || '')}`
    return
  }
  location.href = n.order_id ? orderPath(n.order_id) : '/'
}
/** 点一下整条就算读过（§9.7 的第一条路）。 */
function clickItem(n: any) {
  if (!n.read) void markRead([n.id], 0)
}

watch(() => auth.ready.value, async ready => {
  if (!ready) return
  if (!auth.user.value) { auth.requireUser('/inbox'); return }
  // Markdown 那块 chunk 和这次列表请求一起发出去，正文一到就已经是格式化过的（见 markdown.ts）。
  void preloadMarkdown()
  settings.value = await loadInboxSettings()
  await Promise.all([load(), refreshBadge()])
}, { immediate: true })

watch(showArchived, () => {
  nextBefore.value = null
  hasMore.value = false
  void load()
})
</script>

<template>
<div class="fluent-page">
  <SiteHeader />
  <main class="inbox-main">
    <header class="inbox-head">
      <div>
        <p class="eyebrow">NOTIFICATIONS / 站内信</p>
        <h1>收件箱</h1>
        <small>站内信是单向的，不能回复。要沟通请用页面右下角的客服入口。</small>
      </div>
      <button class="inbox-refresh" title="刷新" :disabled="loading" @click="load()">
        <RefreshCw :size="17" />
      </button>
    </header>

    <p v-if="!auth.ready.value" class="fluent-empty">正在确认登录状态…</p>
    <p v-else-if="!auth.user.value" class="fluent-empty">正在跳转到登录页…</p>
    <template v-else>
      <div class="inbox-toolbar">
        <div class="inbox-tabs">
          <button :class="{ active: !showArchived }" @click="showArchived = false">
            <Inbox :size="16" />收件箱
            <em v-if="badge.unread.value">{{ badge.unread.value }}</em>
          </button>
          <button :class="{ active: showArchived }" @click="showArchived = true">
            <Archive :size="16" />已归档
          </button>
        </div>
        <div class="inbox-toolbar-actions">
          <span v-if="badge.pending.value" class="inbox-pending-count">
            <Pin :size="13" />{{ badge.pending.value }} 条待处理
          </span>
          <button v-if="unreadOnPage.length" class="fluent-secondary" @click="markAllRead">
            <CheckCheck :size="15" />全部标为已读
          </button>
        </div>
      </div>

      <p v-if="message" class="inbox-message">{{ message }}</p>

      <p v-if="loading" class="fluent-empty">正在加载站内信…</p>
      <div v-else-if="!items.length" class="fluent-empty inbox-empty">
        <Bell :size="28" />
        <h2>{{ showArchived ? '归档里是空的' : '收件箱是空的' }}</h2>
        <p>{{ showArchived ? '归档过的站内信会留在这里，随时可以移回去。'
          : '订单、退款和系统通知会出现在这里。' }}</p>
      </div>

      <div v-else class="inbox-list">
        <article v-for="n in items" :key="n.id" :ref="el => bindItem(n.id, el)"
          class="inbox-item"
          :class="{ unread: !n.read, pinned: n.pinned, highlighted: n.highlighted }"
          @click="clickItem(n)">
          <header>
            <component :is="KIND_ICON[n.kind] || Bell" :size="17" />
            <b>{{ n.title }}</b>
            <em v-if="!n.read" class="inbox-dot" title="未读" />
            <span v-if="n.state" class="inbox-state" :class="`inbox-${n.state}`">{{ stateLabel(n.state) }}</span>
          </header>

          <p class="inbox-meta">
            <span>{{ kindLabel(n.kind) }}</span>
            <span v-if="n.scope !== 'user'">{{ scopeLabel(n.scope) }}</span>
            <time>{{ when(n.created_at) }}</time>
            <span v-if="n.pinned" class="inbox-pin"><Pin :size="12" />置顶</span>
          </p>

          <div class="inbox-body markdown-body" v-html="bodyHtml(n)"></div>

          <div class="inbox-actions">
            <template v-for="(a, i) in (n.actions || [])" :key="i">
              <a v-if="a.type === 'link'" class="fluent-secondary" :href="a.href">
                {{ a.label }}<ExternalLink :size="14" />
              </a>
              <button v-else-if="canUseAction(a.type, auth.rank.value)"
                :class="a.type === 'approve_refund' ? 'fluent-primary' : 'fluent-secondary'"
                :disabled="busy === n.id"
                @click.stop="needsReason(a.type) ? openForm(n, a) : runAction(n, a)">
                {{ a.label }}
              </button>
            </template>
            <a v-if="relatedOrder(n)" class="inbox-order" :href="relatedOrder(n)">查看订单</a>
            <button class="inbox-archive" :disabled="busy === n.id" @click.stop="toggleArchive(n)">
              <component :is="n.archived ? ArchiveRestore : Archive" :size="15" />
              {{ n.archived ? '移回收件箱' : '归档' }}
            </button>
          </div>

          <form v-if="form && form.id === n.id" class="inbox-form"
            @click.stop @submit.prevent="submitForm">
            <label v-if="form.type === 'transfer_refund'">
              <span>转交给</span>
              <select v-model="formTo" required>
                <option value="">选择一位管理员</option>
                <option v-for="u in admins" :key="u.user_id" :value="u.user_id">
                  {{ u.display_name || u.email || u.user_id.slice(0, 8) }}
                </option>
              </select>
              <small v-if="!admins.length">没有别的管理员可以转交。</small>
            </label>
            <label>
              <span>{{ form.type === 'reject_refund' ? '拒绝理由' : '转交说明' }}</span>
              <textarea v-model="formNote" rows="3" maxlength="2000" required
                :placeholder="form.type === 'reject_refund'
                  ? '写清楚为什么拒绝，这段话会发给申请人'
                  : '接手的人要知道为什么轮到他'"></textarea>
              <small>{{ formNote.length }}/2000</small>
            </label>
            <div class="inbox-form-row">
              <button class="fluent-primary" :disabled="busy === n.id">
                {{ busy === n.id ? '处理中…' : form.label }}
              </button>
              <button type="button" class="fluent-secondary" @click="form = null">取消</button>
            </div>
          </form>
        </article>
      </div>
      <div v-if="hasMore" class="inbox-more">
        <button class="fluent-secondary" :disabled="paging" @click="load(true)">
          {{ paging ? '载入中…' : '载入更多' }}
        </button>
      </div>

      <p v-if="!loading && items.length && !showArchived" class="inbox-note">
        已读的站内信会在 {{ settings.auto_archive_days }} 天后自动归档；待处理的不会自动消失。
      </p>
    </template>
  </main>
  <SiteFooter />
</div>
</template>
