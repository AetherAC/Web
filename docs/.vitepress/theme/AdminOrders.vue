<script setup lang="ts">
/**
 * §12 订单管理页面。后端是 api/_routes/admin-orders.mjs，这一页只把它已经算好的东西显示出来。
 *
 * 四件事故意不在前端做：
 * - 联系方式脱敏。接口回来的 user_email 已经是 a****c@gmail.com，浏览器里根本拿不到完整邮箱。这里不
 *   做二次处理，也不去 user_profiles 补齐——补齐等于把服务端刚打的码抹掉（理由见那个文件的文件头）。
 * - 「下一步能改成什么」。next_statuses 由状态机给（shared/orders.mjs），前端不自己算一份：两份判断
 *   迟早分叉，而分叉的表现是按钮亮着、点下去 409。
 * - 搜索。三项都是精确匹配，因为这个接口 rank ≥ 111 就能调；模糊搜索会让任何组织成员用一个字母把全
 *   部订单号捞出来，那是枚举不是搜索。前端连「包含」这个选项都不提供。
 * - 每页条数。page_size 来自 site_settings.order_list_page_size（§14），改配置就该立刻生效。
 *
 * 读取门槛是 rank ≥ 111（§12.2 确认过：加入组织就是拿到这个可见性的方式），改状态只有 admin。
 * can_modify 为 false 时表单照画，只是禁用并写明原因——§13.2 要的是可见但不可点；藏起来会让人以为
 * 这个功能不存在，然后去问客服。
 */
import { computed, reactive, ref, watch } from 'vue'
import {
  ChevronLeft, ChevronRight, CircleAlert, Download, PackageOpen, ReceiptText,
  RotateCcw, Search, ShieldCheck, UserRound, Wallet, X
} from 'lucide-vue-next'
import { supabase, useAuth } from './auth'
import {
  ORDER_STATUSES, ORDER_STATUS_LABEL, REFUND_PROXY_GROUPS, REFUND_STATUS_LABEL,
  canRequestRefund, transitionLabel
} from '../../../shared/orders.mjs'
import { formatMinor } from '../../../shared/coupons.mjs'

const auth = useAuth()

/** §12.3 的筛选条件。空串一律不拼进 query，后端把缺省当「不筛」。 */
const FILTER_DEFAULTS = {
  search_field: 'order_no', search: '', status: '', provider: '',
  created_from: '', created_to: '', paid_from: '', paid_to: ''
}
const filters = reactive({ ...FILTER_DEFAULTS })

const SEARCH_HINT: Record<string, string> = {
  order_no: '订单号就是订单的 uuid，要填完整——这里是精确匹配，填前 8 位查不到。',
  user_id: '用户 uuid，可以从「用户管理」那一页复制。',
  payment_id: '支付平台的流水号或平台订单号，两列都会查（老订单只有后者）。'
}
const SEARCH_PLACEHOLDER: Record<string, string> = {
  order_no: '00000000-0000-0000-0000-000000000000',
  user_id: '00000000-0000-0000-0000-000000000000',
  payment_id: 'ch_3Pxxxxxxxxxxxx'
}
/** initiator_role 的取值，和 refund_requests_initiator_role_check 对齐。 */
const INITIATOR_LABEL: Record<string, string> = {
  user: '用户本人', postsale: '售后客服代提', cs: '客服代提', admin: '管理员代提'
}
/** §12.5 的变更来源。库里存的是这五个字面量。 */
const SOURCE_LABEL: Record<string, string> = {
  user: '用户操作', cs: '客服操作', admin: '管理员操作', system: '系统', callback: '支付回调'
}

const rows = ref<any[]>([])
const total = ref(0)
const offset = ref(0)
const pageSize = ref(20)
const canModify = ref(false)
const loading = ref(false)
const exporting = ref(false)
const message = ref('')
const providers = ref<any[]>([])

const detail = ref<any>(null)
const detailLoading = ref(false)
const detailMessage = ref('')
const changeTo = ref('')
const changeNote = ref('')
const changing = ref(false)

/** §13.3 的第三个入口：管理员/售后在订单详情里代提退款。金额留空就退全额。 */
const refundReason = ref('')
const refundAmount = ref<number | null>(null)
const refundSending = ref(false)

const money = (minor: any, currency?: string | null) =>
  minor === null || minor === undefined ? '—' : formatMinor(minor, currency || 'USD')
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—')
/** 列表里显示前 8 位，全长挂 title。一行 uuid 在表格里只是噪音，但跟渠道对账时要全长。 */
const shortId = (id: string) => String(id || '').slice(0, 8).toUpperCase()
const statusLabel = (s: string) => ORDER_STATUS_LABEL[s] || s
const refundLabel = (s: string) => REFUND_STATUS_LABEL[s] || s
const providerLabel = (id: string) => providers.value.find(p => p.id === id)?.display_name || id

const pages = computed(() => Math.max(1, Math.ceil(total.value / (pageSize.value || 20))))
const page = computed(() => Math.floor(offset.value / (pageSize.value || 20)) + 1)
/** 代提要在 REFUND_PROXY_GROUPS 里。read / coworker / presale 能看订单，但不该碰钱。 */
const canProxyRefund = computed(() => REFUND_PROXY_GROUPS.includes(auth.group.value as string))

async function api(path: string, options: any = {}) {
  const token = auth.session.value?.access_token
  const r = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`)
  return data
}

/** 只把填了的条件拼进 query。孤立的 search_field 也不发：没有搜索词时它没有意义。 */
function queryString(extra: Record<string, string> = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (String(value ?? '').trim()) params.set(key, String(value))
  }
  if (!filters.search.trim()) params.delete('search_field')
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  return params.toString()
}

async function load(nextOffset = offset.value) {
  loading.value = true
  message.value = ''
  try {
    const data = await api(`/api/admin-orders?${queryString({ offset: String(nextOffset) })}`)
    rows.value = data.orders || []
    total.value = data.total || 0
    offset.value = data.offset || 0
    // limit 是后端夹过上限之后的实际每页条数；page_size 是配置值。翻页要用前者，否则最后一页会跳空。
    pageSize.value = data.limit || data.page_size || 20
    canModify.value = Boolean(data.can_modify)
    if (!rows.value.length) message.value = total.value ? '这一页没有记录，请回到第一页' : '没有符合条件的订单'
  } catch (e: any) {
    rows.value = []
    total.value = 0
    message.value = e.message
  } finally {
    loading.value = false
  }
}

/** 改了条件就回第一页。留在第 7 页上换条件，结果通常是一个空列表加一句「没有符合条件的订单」。 */
const search = () => load(0)
function resetFilters() {
  Object.assign(filters, FILTER_DEFAULTS)
  return load(0)
}
function turnPage(delta: number) {
  const next = offset.value + delta * (pageSize.value || 20)
  if (next < 0 || next >= total.value) return
  return load(next)
}

/**
 * 渠道下拉。enabled 的渠道由 providers_read 放给所有登录用户，停用的只有管理员看得到——停用渠道的
 * 老订单仍然在列表里，那些行显示渠道 id 原文，因为这份名单里没有它的显示名。
 */
async function loadProviders() {
  if (!supabase) return
  const { data } = await supabase.from('payment_providers').select('id,display_name').order('sort_order')
  providers.value = data ?? []
}

async function openDetail(id: string) {
  detailLoading.value = true
  detailMessage.value = ''
  changeTo.value = ''
  changeNote.value = ''
  refundReason.value = ''
  refundAmount.value = null
  try {
    detail.value = await api(`/api/admin-orders?order_id=${encodeURIComponent(id)}`)
  } catch (e: any) {
    detail.value = null
    message.value = e.message
  } finally {
    detailLoading.value = false
  }
}
const closeDetail = () => { detail.value = null; detailMessage.value = '' }

/**
 * 可直接改成的状态。via_refund 的那两个（退款中 / 已退款）后端会用 409 拒掉，所以不放进下拉——但要在
 * 旁边写出它们为什么不在，否则看起来像状态机少了两条边。
 */
const changeable = computed(() => (detail.value?.next_statuses || []).filter((s: any) => !s.via_refund))
const viaRefund = computed(() => (detail.value?.next_statuses || []).filter((s: any) => s.via_refund))
/** 判定和文案都来自 shared/orders.mjs，和 api/refund-request.mjs 用的是同一个函数：灰按钮上写的理由，
 *  就是真的点下去会收到的那句 409。 */
const refundGate = computed(() => canRequestRefund(detail.value?.order, detail.value?.open_refund))

async function changeStatus() {
  const order = detail.value?.order
  if (!order || !changeTo.value) return
  if (!changeNote.value.trim()) { detailMessage.value = '请填写变更说明'; return }
  const target = changeable.value.find((s: any) => s.status === changeTo.value)
  if (!confirm(`把订单 ${shortId(order.id)} 从「${statusLabel(order.status)}」改为「${target?.label}」？\n\n这条变更会记进订单变更记录，买家在自己的订单页上能看到你填的说明。`)) return
  changing.value = true
  detailMessage.value = ''
  try {
    await api('/api/admin-orders', {
      method: 'PATCH',
      body: JSON.stringify({ order_id: order.id, status: changeTo.value, note: changeNote.value.trim() })
    })
    // 详情和列表都要重读：状态变了，列表那一行的状态标签和详情里的变更记录都会跟着变。
    await Promise.all([openDetail(order.id), load()])
    detailMessage.value = '状态已变更，变更记录里已经能看到这一条'
  } catch (e: any) {
    detailMessage.value = e.message
  } finally {
    changing.value = false
  }
}

/**
 * §13.3 的第三个入口。打的是同一个 /api/refund-request，所以四件事都不用在这里重写：可退判定、
 * §10.2 的金额上限、refund_audit_log 里的创建记录、以及 §10.3 那封发给全体管理员的审批站内信。
 */
async function proxyRefund() {
  const order = detail.value?.order
  if (!order) return
  if (!refundReason.value.trim()) { detailMessage.value = '请填写退款原因'; return }
  const body: any = {
    order_id: order.id,
    reason_code: 'staff_proxy',
    reason_detail: refundReason.value.trim()
  }
  // 金额留空表示退全额。填了就发整数：validateRefundAmount 只收整数 number，字符串会被它响亮拒掉。
  const wanted = refundAmount.value
  if (wanted !== null && wanted !== undefined && String(wanted) !== '') body.amount_minor = Math.round(Number(wanted))
  refundSending.value = true
  detailMessage.value = ''
  try {
    const data = await api('/api/refund-request', { method: 'POST', body: JSON.stringify(body) })
    // notified 为 false 是「申请落库了、审批站内信没写进去」。如实说：申请仍在待审批列表里。
    detailMessage.value = data.notified === false
      ? '退款申请已提交；审批站内信没能发出，但申请已进入待审批列表。'
      : '退款申请已提交，全体管理员已收到审批站内信。'
    await openDetail(order.id)
  } catch (e: any) {
    detailMessage.value = e.message
  } finally {
    refundSending.value = false
  }
}

/**
 * §12.4 的导出。不能做成 <a href>：这个接口要 Authorization 头，而浏览器导航不带它——那样点下去下载
 * 到的是一个内容为 {"error":"Authentication required"} 的 csv 文件。所以 fetch 成 blob 再触发下载。
 */
async function exportCsv() {
  exporting.value = true
  message.value = ''
  try {
    const r = await fetch(`/api/admin-orders?${queryString({ view: 'export' })}`, {
      headers: { Authorization: `Bearer ${auth.session.value?.access_token}` }
    })
    if (!r.ok) {
      const data = await r.json().catch(() => ({}))
      throw new Error(data.error || `导出失败（${r.status}）`)
    }
    const url = URL.createObjectURL(await r.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || 'orders.csv'
    link.click()
    // 立刻 revoke 会让部分浏览器来不及取到内容，晚几秒再放。
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    const exported = r.headers.get('X-Export-Total')
    // 被上限截断时必须说出来：不说的话，拿这份表去对账的人会以为这个筛选条件下就这么多单。
    message.value = r.headers.get('X-Export-Truncated') === '1'
      ? `符合条件的共 ${exported} 条，只导出了前 5000 条——请缩小时间范围后分批导出。`
      : `已导出 ${exported} 条`
  } catch (e: any) {
    message.value = e.message
  } finally {
    exporting.value = false
  }
}

watch(() => auth.ready.value, ready => {
  if (!ready || !auth.user.value) return
  void loadProviders()
  void load(0)
}, { immediate: true })
</script>

<template>
<div class="orders-pane">
  <!-- §12.3 的筛选区。整块是一个 form，所以在任何输入框里按回车都等于点「查询」。 -->
  <form class="orders-filters" @submit.prevent="search()">
    <label class="wide">搜索
      <div class="orders-search">
        <select v-model="filters.search_field" aria-label="搜索项">
          <option value="order_no">订单号</option>
          <option value="user_id">用户 ID</option>
          <option value="payment_id">支付 ID</option>
        </select>
        <input v-model="filters.search" type="search" :placeholder="SEARCH_PLACEHOLDER[filters.search_field]" />
        <button class="fluent-primary" :disabled="loading"><Search :size="16" />查询</button>
      </div>
      <small>{{ SEARCH_HINT[filters.search_field] }}</small>
    </label>
    <label>订单状态
      <select v-model="filters.status">
        <option value="">全部</option>
        <option v-for="s in ORDER_STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
      </select>
    </label>
    <label>支付渠道
      <select v-model="filters.provider">
        <option value="">全部</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.display_name || p.id }}</option>
      </select>
    </label>
    <label>下单时间起<input v-model="filters.created_from" type="datetime-local" /></label>
    <label>下单时间止<input v-model="filters.created_to" type="datetime-local" /></label>
    <label>支付时间起<input v-model="filters.paid_from" type="datetime-local" /></label>
    <label>支付时间止<input v-model="filters.paid_to" type="datetime-local" /></label>
  </form>

  <div class="orders-bar">
    <span>
      共 {{ total }} 条 · 第 {{ page }} / {{ pages }} 页
      <template v-if="!canModify"> · 只读：修改订单状态需要管理员</template>
    </span>
    <span class="toolbar-actions">
      <button :disabled="offset <= 0 || loading" @click="turnPage(-1)"><ChevronLeft :size="16" />上一页</button>
      <button :disabled="offset + pageSize >= total || loading" @click="turnPage(1)">下一页<ChevronRight :size="16" /></button>
      <button :disabled="exporting || loading" @click="exportCsv">
        <Download :size="16" />{{ exporting ? '正在导出…' : '导出 CSV' }}
      </button>
      <button :disabled="loading" @click="resetFilters"><X :size="16" />清空条件</button>
    </span>
  </div>

  <div v-if="loading" class="fluent-empty">正在加载订单…</div>
  <div v-else class="orders-table order-table">
    <header><span>订单号</span><span>时间</span><span>用户</span><span>商品</span><span>应付 / 实付</span><span>渠道</span><span>状态</span></header>
    <!-- 行做成 button 而不是 div：键盘要能 Tab 过来按回车，读屏也要知道这一行是可点的。 -->
    <button
      v-for="o in rows" :key="o.id" type="button"
      :class="{ selected: detail?.order?.id === o.id }" @click="openDetail(o.id)">
      <span :title="o.id"><b>{{ shortId(o.id) }}</b><small>{{ o.payment_reference || o.provider_order_id || '无平台单号' }}</small></span>
      <span><b>{{ when(o.created_at) }}</b><small>{{ o.paid_at ? `支付 ${when(o.paid_at)}` : '未支付' }}</small></span>
      <!-- 邮箱已经是服务端脱敏过的；user_id 只挂在 title 上，需要精确搜索时再复制。 -->
      <span :title="o.user_id"><b>{{ o.user_email || '—' }}</b><small>{{ o.user_name || shortId(o.user_id) }}</small></span>
      <span><b>{{ o.sku_name || o.sku }}</b><small>{{ o.sku }} · ×{{ o.quantity || 1 }}</small></span>
      <span>
        <b>{{ money(o.amount_minor, o.currency) }}</b>
        <small>{{ o.paid_amount_minor === null || o.paid_amount_minor === undefined ? '—' : money(o.paid_amount_minor, o.paid_currency || o.currency) }}</small>
      </span>
      <span><b>{{ providerLabel(o.provider) }}</b><small v-if="o.coupon_code">券 {{ o.coupon_code }}</small></span>
      <span><em :class="`order-${o.status}`">{{ statusLabel(o.status) }}</em></span>
    </button>
  </div>
  <p v-if="message" class="admin-message">{{ message }}</p>

  <div v-if="detailLoading" class="fluent-empty">正在加载订单详情…</div>
  <template v-else-if="detail">
    <section class="order-summary orders-detail-head">
      <div>
        <p :title="detail.order.id">ORDER / {{ shortId(detail.order.id) }}</p>
        <h1>{{ detail.line.name || detail.line.sku }}</h1>
        <span :class="`order-${detail.order.status}`">{{ statusLabel(detail.order.status) }}</span>
      </div>
      <strong>{{ money(detail.order.paid_amount_minor ?? detail.order.amount_minor, detail.order.paid_currency || detail.order.currency) }}</strong>
      <button class="icon-button" title="关闭详情" @click="closeDetail"><X :size="18" /></button>
    </section>

    <div class="order-detail-grid">
      <article>
        <h2><PackageOpen :size="18" />商品信息</h2>
        <dl>
          <div><dt>构建</dt><dd>{{ detail.line.sku }}</dd></div>
          <div><dt>名称</dt><dd>{{ detail.line.name || '—' }}</dd></div>
          <div><dt>数量</dt><dd>{{ detail.line.quantity || 1 }}</dd></div>
        </dl>
        <!-- 名称和描述是下单那一刻的快照（orders.sku_name / sku_description），不是现在的商品定义。 -->
        <p v-if="detail.line.description" class="order-desc">{{ detail.line.description }}</p>
      </article>

      <article>
        <h2><Wallet :size="18" />金额</h2>
        <dl>
          <div><dt>原价</dt><dd>{{ money(detail.line.list_amount_minor ?? detail.line.amount_minor, detail.line.currency) }}</dd></div>
          <div v-if="detail.line.coupon_code || detail.line.discount_minor" class="order-discount">
            <dt>优惠券</dt>
            <dd><code v-if="detail.line.coupon_code">{{ detail.line.coupon_code }}</code><span>−{{ money(detail.line.discount_minor || 0, detail.line.currency) }}</span></dd>
          </div>
          <div><dt>应付</dt><dd>{{ money(detail.order.amount_minor, detail.order.currency) }}</dd></div>
          <div><dt>实付</dt><dd>{{ money(detail.order.paid_amount_minor, detail.order.paid_currency || detail.order.currency) }}</dd></div>
        </dl>
      </article>

      <article>
        <h2><UserRound :size="18" />用户与支付</h2>
        <dl>
          <!-- 服务端脱敏过的邮箱。想看完整邮箱去「用户管理」，那一页门槛是 admin。 -->
          <div><dt>联系邮箱</dt><dd>{{ detail.order.user_email || '—' }}</dd></div>
          <div><dt>用户 ID</dt><dd><code class="orders-uuid">{{ detail.order.user_id }}</code></dd></div>
          <div><dt>支付渠道</dt><dd>{{ providerLabel(detail.order.provider) }}</dd></div>
          <div><dt>平台单号</dt><dd>{{ detail.order.payment_reference || detail.order.provider_order_id || '等待支付' }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ when(detail.order.created_at) }}</dd></div>
          <div><dt>支付时间</dt><dd>{{ when(detail.order.paid_at) }}</dd></div>
        </dl>
        <p class="orders-hint">
          <CircleAlert :size="15" />邮箱在服务端就打了码，这一页拿不到完整地址——F12 里也没有。客服电话核对身份够用，要完整邮箱请去「用户管理」。
        </p>
      </article>

      <article>
        <h2><ShieldCheck :size="18" />操作区</h2>
        <p v-if="!detail.can_modify" class="orders-hint">
          <CircleAlert :size="15" />只有管理员可以修改订单状态。下面的表单对你是禁用的，列出来是为了让你知道这笔订单当前合法的下一步有哪些。
        </p>
        <form class="orders-change" @submit.prevent="changeStatus">
          <label>改为
            <select v-model="changeTo" :disabled="!detail.can_modify || !changeable.length">
              <option value="">请选择</option>
              <option v-for="s in changeable" :key="s.status" :value="s.status">{{ s.label }}</option>
            </select>
          </label>
          <label>变更说明（必填）
            <textarea
              v-model="changeNote" rows="3" maxlength="2000" :disabled="!detail.can_modify"
              placeholder="为什么要手工改这笔订单？例如「渠道回调丢失，已在支付平台后台核对到账」。三个月后对账的人只有这句话可看，买家在自己的订单页上也能看到它。"></textarea>
          </label>
          <button class="fluent-primary" :disabled="!detail.can_modify || !changeTo || changing">
            {{ changing ? '提交中…' : '变更状态' }}
          </button>
        </form>
        <p v-if="!changeable.length" class="orders-hint">
          <CircleAlert :size="15" />{{ statusLabel(detail.order.status) }} 没有可以直接变更的下一步。
        </p>
        <!-- 这两个状态在状态机里是合法迁移，但各自绑着别的东西，所以不在下拉里。说清楚比留白好。 -->
        <p v-if="viaRefund.length" class="orders-hint">
          <CircleAlert :size="15" />{{ viaRefund.map((s: any) => s.label).join('、') }} 只能由退款流程产生：直接改会留下一笔查不到申请、也查不到审批人的退款。请在下面发起退款申请，或到收件箱里审批。
        </p>

        <div v-if="canProxyRefund" class="orders-proxy">
          <h3><RotateCcw :size="16" />代用户发起退款</h3>
          <form v-if="refundGate.ok" @submit.prevent="proxyRefund">
            <label>退款原因（必填）
              <textarea v-model="refundReason" rows="3" maxlength="2000" required
                placeholder="替用户提交的理由，会原样出现在发给全体管理员的审批站内信里。"></textarea>
            </label>
            <label>退款金额（最小货币单位，留空退全额 {{ money(refundGate.maxAmountMinor, detail.order.paid_currency || detail.order.currency) }}）
              <input v-model.number="refundAmount" type="number" min="1" step="1" :max="refundGate.maxAmountMinor"
                :placeholder="String(refundGate.maxAmountMinor)" />
            </label>
            <button class="fluent-secondary" :disabled="refundSending">{{ refundSending ? '提交中…' : '提交退款申请' }}</button>
          </form>
          <template v-else>
            <button class="fluent-secondary" disabled :title="refundGate.reason">提交退款申请</button>
            <p class="orders-hint"><CircleAlert :size="15" />{{ refundGate.reason }}</p>
          </template>
        </div>
        <p v-if="detailMessage" class="admin-message">{{ detailMessage }}</p>
      </article>
    </div>

    <section v-if="detail.refunds.length" class="order-log orders-refunds">
      <h2>退款申请（{{ detail.refunds.length }}）</h2>
      <ol>
        <li v-for="r in detail.refunds" :key="r.id">
          <b :class="`refund-${r.status}`">{{ refundLabel(r.status) }}</b>
          <span>{{ money(r.amount_minor, r.currency || detail.order.currency) }}</span>
          <span>{{ INITIATOR_LABEL[r.initiator_role] || r.initiator_role }}</span>
          <em v-if="r.reason_detail">{{ r.reason_detail }}</em>
          <small>{{ when(r.created_at) }}</small>
        </li>
      </ol>
      <!-- 审批、转交、打款都不在这一页：那三个动作要记下审批人和理由，而记录是通知上的按钮在做。 -->
      <p class="orders-hint">
        <CircleAlert :size="15" />审批、转交和执行打款在<a href="/inbox">收件箱</a>的审批通知上操作——审批人、理由和二次确认都由那条通知记录，这一页只显示进展。
      </p>
    </section>

    <section v-if="detail.logs.length" class="order-log">
      <h2>订单变更记录</h2>
      <ol>
        <li v-for="entry in detail.logs" :key="entry.id">
          <b>{{ transitionLabel(entry.from_status, entry.to_status) }}</b>
          <span>{{ SOURCE_LABEL[entry.source] || entry.source }}</span>
          <span v-if="entry.actor_group">{{ entry.actor_group }}</span>
          <em v-if="entry.note">{{ entry.note }}</em>
          <small>{{ when(entry.created_at) }}</small>
        </li>
      </ol>
    </section>
  </template>
</div>
</template>
