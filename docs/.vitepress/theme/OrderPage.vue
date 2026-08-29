<script setup lang="ts">
/**
 * §5 订单信息展示，以及 §13 退款状态机在用户侧的那一半。
 *
 * 三个金额都显示（原价 / 应付 / 实付），因为它们在库里就是三列（见 schema.sql 里 §5 那段）：应付是原价
 * 经优惠券调整后要付的钱，实付是支付平台实际到账的钱。三者通常相等，不相等的时候（币种换算、少付、
 * 超付）正是买家最需要看清的时候，而只显示一个数字会把那种情况变成一句「金额不对」的客服工单。
 *
 * 退款申请提交给 POST /api/refund-request，不再由浏览器直接 insert 进 refund_requests。直接 insert 能过
 * RLS（own_refunds_insert 允许本人给自己已支付的订单插一行），但会绕掉四件事：§13.2 的可退判定、
 * §10.2 的金额上限、refund_audit_log 里的创建记录、以及最要紧的 §10.3 那封发给全部管理员的审批站内信
 * ——绕掉最后一条的表现不是报错，是申请安静地躺在表里，没有任何人知道有一笔退款要审。
 */
import { computed, ref, watch } from 'vue'
import {
  ArrowLeft, CircleAlert, ExternalLink, FileImage, ImagePlus, PackageOpen,
  ReceiptText, RotateCcw, ShieldAlert, Ticket, Wallet, XCircle
} from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'
import { supabase, useAuth } from './auth'
import {
  ORDER_STATUS_LABEL, REFUND_STATUS_LABEL, canRequestRefund, transitionLabel
} from '../../../shared/orders.mjs'
import { ZERO_DECIMAL_CURRENCIES } from '../../../shared/coupons.mjs'

const auth = useAuth()

const order = ref<any>(null)
const refunds = ref<any[]>([])
const logs = ref<any[]>([])
const denied = ref(false)
const loading = ref(true)

const reason = ref('duplicate')
const detail = ref('')
const files = ref<File[]>([])
const message = ref('')
const sending = ref(false)
/** 证据图的签名 URL，按路径缓存。桶是私有的，直接把 path 当 src 会拿到 400。 */
const evidenceUrls = ref<Record<string, string>>({})

const cancelling = ref(false)
const cancelMessage = ref('')

/** §12.5 的变更来源。库里存的是 user/cs/admin/system/callback 五个字面量。 */
const SOURCE_LABEL: Record<string, string> = {
  user: '用户操作', cs: '客服操作', admin: '管理员操作', system: '系统', callback: '支付回调'
}
// Only the query form. The old `/order/<uuid>` path never reached this line: VitePress looks routes up
// in a build-time hash map of its .md files, finds no entry for a uuid segment, and swaps in its 404
// component — so the pathname branch that used to be here was unreachable code standing where a bug was.
// vercel.json redirects the old shape here so links already in the wild, and any checkout session
// created before this fix, still land on a working page.
const orderId = () => new URLSearchParams(location.search).get('order_id')
const justPaid = () => typeof window !== 'undefined' && new URLSearchParams(location.search).get('paid') === '1'

/**
 * 金额显示。零小数位的币种不能除 100——除了就把 1000 日元显示成 10 日元。
 *
 * 名单从 shared/coupons.mjs 取，和后端 formatMinor 用的是同一份；在这里再抄一遍的话，某天加了一个
 * 币种就会出现「订单页显示 10、邮件里显示 1000」这种没人能立刻解释的差异。Intl 对不认识的币种码抛
 * RangeError，而币种是从库里读出来的字符串，所以兜一层，宁可显示得难看也不要把整页渲染掉。
 */
function money(minor: number | null | undefined, currency?: string | null) {
  if (minor === null || minor === undefined) return '—'
  const n = Number(minor)
  if (!Number.isFinite(n)) return '—'
  const c = String(currency || 'USD').toUpperCase()
  const value = ZERO_DECIMAL_CURRENCIES.includes(c) ? n : n / 100
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: c }).format(value) }
  catch { return `${value} ${c}` }
}

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—')
const statusLabel = (s: string) => ORDER_STATUS_LABEL[s] || s
const refundLabel = (s: string) => REFUND_STATUS_LABEL[s] || s

async function fetchOrder(strict = false) {
  const { data, error } = await supabase!.from('orders').select('*').eq('id', orderId()).maybeSingle()
  if (error || !data) { if (strict) denied.value = true; return null }
  order.value = data
  return data
}

/**
 * 退款申请按时间倒序取全部，不是 maybeSingle()。
 *
 * §13.5 允许被拒之后重提（one_open_refund_per_order 是部分唯一索引，终态不占位），所以一个订单可以有
 * 多条申请行。maybeSingle() 碰到两行返回的是错误而不是第一行，于是补过材料重提过的订单会在这一页上
 * 丢掉全部退款信息——而那恰好是最需要看到进展的那一批订单。
 */
async function fetchRefunds(id: string) {
  const { data } = await supabase!.from('refund_requests')
    .select('id,status,amount_minor,currency,reason_detail,evidence_paths,decision_note,execution_note,created_at,decided_at')
    .eq('order_id', id).order('created_at', { ascending: false })
  refunds.value = data ?? []
  for (const r of refunds.value) for (const path of r.evidence_paths || []) void signEvidence(path)
}
/**
 * §5 的订单变更记录。order_log_read 让订单本人读自己那些行，所以这里直接查库，不用接口。
 *
 * note 是管理员手填的变更说明（§12.5 要求必填），照原样显示给买家。RLS 已经允许买家读到这一列，不显示
 * 并不会让它变成内部信息，只会让人以为它是；而手工改过状态的订单恰好都是异常订单，那句说明是买家唯一
 * 能看到的解释。actor_id 不查：一个 uuid 对买家没有意义，不查就不用考虑要不要显示。
 */
async function fetchLogs(id: string) {
  const { data } = await supabase!.from('order_status_log')
    .select('id,from_status,to_status,source,note,created_at')
    .eq('order_id', id).order('created_at', { ascending: false }).limit(50)
  logs.value = data ?? []
}

async function signEvidence(path: string) {
  if (evidenceUrls.value[path]) return
  const { data } = await supabase!.storage.from('refund-evidence').createSignedUrl(path, 600)
  if (data?.signedUrl) evidenceUrls.value = { ...evidenceUrls.value, [path]: data.signedUrl }
}

async function loadAll() {
  const data = await fetchOrder(true)
  if (!data) return null
  await Promise.all([fetchRefunds(data.id), fetchLogs(data.id)])
  return data
}

watch(() => auth.ready.value, async ready => {
  if (!ready) return
  // The search string has to come along, or signing in sends the buyer back to /order with no id.
  if (!auth.user.value) { auth.requireUser(typeof window === 'undefined' ? '/order' : location.pathname + location.search); return }
  loading.value = true
  const data = await loadAll()
  loading.value = false
  if (!data) return
  // Stripe and PayPal send the buyer back here before their callback has necessarily landed, so an
  // order that was just paid can still read `pending` for a few seconds. Poll instead of showing
  // this buyer a "继续付款" button for money they have already handed over.
  if (justPaid() && data.status === 'pending') {
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      const next = await fetchOrder()
      // 状态一变就把日志和退款一起重读：回调那一刻会写一条 PENDING → PAID，而这一页正要显示它。
      if (next && next.status !== 'pending') { await loadAll(); break }
    }
  }
}, { immediate: true })

/** 最新一条申请决定这一页显示什么：在途的显示进展，被拒的下面重新给出表单（§13.5）。 */
const latestRefund = computed(() => refunds.value[0] ?? null)
/**
 * §13.2：不可退时按钮置灰并给出说明。
 *
 * 判定和文案都来自 shared/orders.mjs 的 canRequestRefund，而 api/refund-request.mjs 调的是同一个函数
 * ——所以灰按钮上写的理由，和真的点下去会收到的那句 409 是同一句话。这一点是这个函数存在的全部理由：
 * 在这里自己判一遍「status === 'paid'」看起来更简单，但它漏掉「已经有一条在途申请」那一半，
 * 而那一半在订单状态上看不出来（§13.3 规定申请提交时订单还是 PAID）。
 *
 * 说明同时挂在 title 上和写成一行可见文字：只挂 title 的话，触屏和读屏都读不到它。
 */
const refundGate = computed(() => canRequestRefund(order.value, latestRefund.value))

/** §5：名称和描述取订单上的快照，不是现在的商品定义——历史订单要显示当时买的是什么。 */
const productName = computed(() => order.value?.sku_name || order.value?.sku || '')

/** 用了券才显示那一行。没用券时显示「无」会让「没用券」和「券信息没读出来」看起来一样。 */
const hasDiscount = computed(() =>
  Number(order.value?.discount_minor || 0) > 0 || Boolean(order.value?.coupon_code))

/** 实付和应付不一致要说出来。这不是罕见的显示分支，币种换算和超付都会走到它。 */
const paidDiffers = computed(() => {
  const o = order.value
  if (!o || o.paid_amount_minor === null || o.paid_amount_minor === undefined) return false
  return Number(o.paid_amount_minor) !== Number(o.amount_minor) ||
    Boolean(o.paid_currency && o.paid_currency !== o.currency)
})

// 证据的三条限制。前两条和 storage.buckets 里 refund-evidence 那行逐字对应（5 MB、jpeg/png/webp），
// 第三条是 api/refund-request.mjs 的 evidence_paths 上限。这一遍不是信任边界——桶和接口各自都会再判
// 一次——它存在只为了给出一句人能看懂的话：storage 拒收时回的是英文的 "The object exceeded the
// maximum allowed size"，而买家此刻正在给一笔付过钱的订单申请退款。
const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024
const EVIDENCE_MIME = ['image/jpeg', 'image/png', 'image/webp']
const EVIDENCE_MAX_COUNT = 10

function pickFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const rejected: string[] = []
  const kept: File[] = []
  for (const file of Array.from(input.files || [])) {
    if (!EVIDENCE_MIME.includes(file.type)) { rejected.push(`${file.name}（只支持 JPG / PNG / WebP）`); continue }
    if (file.size > EVIDENCE_MAX_BYTES) { rejected.push(`${file.name}（单张不超过 5 MB）`); continue }
    kept.push(file)
  }
  if (kept.length > EVIDENCE_MAX_COUNT) rejected.push(`一次最多 ${EVIDENCE_MAX_COUNT} 张，多出的已忽略`)
  files.value = kept.slice(0, EVIDENCE_MAX_COUNT)
  // 清掉 input 的值，否则同一个文件第二次选中不会触发 change。文件名由下面自己列出来，不靠控件显示。
  input.value = ''
  message.value = rejected.length ? `以下文件没有被采用：${rejected.join('；')}` : ''
}
async function submitRefund() {
  if (!order.value || !auth.user.value || !auth.session.value) return
  // 提交前再问一遍那道门禁。按钮本来已经是灰的，但两个标签页里各点一次仍然到得了这里，而这里挡住的
  // 是一次已经发生的上传：证据必须先进桶才能把路径提交上去，而 refund-evidence 上只有 insert 和 select
  // 两条策略（见 schema.sql），没有 delete——被接口拒掉的那几张图浏览器自己删不掉，会一直留在桶里。
  const gate = canRequestRefund(order.value, latestRefund.value)
  if (!gate.ok) { message.value = gate.reason; return }
  if (!detail.value.trim()) { message.value = '请填写退款原因'; return }

  sending.value = true
  message.value = ''
  try {
    const paths: string[] = []
    for (const file of files.value) {
      // 第一段必须是 auth.uid()：refund_evidence_insert 按 foldername[1] 判归属，写别的段会被策略拒收。
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `${auth.user.value.id}/${order.value.id}/${crypto.randomUUID()}-${safe}`
      const { error } = await supabase!.storage.from('refund-evidence')
        .upload(path, file, { contentType: file.type })
      if (error) throw new Error(`证据上传失败：${error.message}`)
      paths.push(path)
    }
    const response = await fetch('/api/refund-request', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.session.value.access_token}`,
        'Content-Type': 'application/json'
      },
      // 故意不带 amount_minor。金额由客服确认（§10.2），带上去接口会回 403，而那对买家来说是一句
      // 莫名其妙的报错——这一页从来不该有金额输入框，所以这里连字段都不出现。
      body: JSON.stringify({
        order_id: order.value.id,
        reason_code: reason.value,
        reason_detail: detail.value.trim(),
        evidence_paths: paths
      })
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `提交失败（${response.status}）`)
    // notified 为 false 是「申请落库了、审批站内信没写进去」。如实说，但不叫买家去找客服：
    // 申请仍然在待审批列表里，管理员照样看得到，催客服只会多一个人做无用功。
    message.value = data.notified === false
      ? '退款申请已提交。审批通知没能发出，但申请已进入待审批列表。'
      : '退款申请已提交，管理员审批后会通过站内信通知你。'
    detail.value = ''
    files.value = []
    await Promise.all([fetchRefunds(order.value.id), fetchLogs(order.value.id)])
  } catch (e: any) {
    message.value = e.message
  } finally {
    sending.value = false
  }
}
/**
 * 取消待支付订单。§12.2 只允许 PENDING → CANCELLED，判定在 api/cancel-order.mjs 里。
 *
 * 那句「若仍完成付款，订单会重新变为已支付」不是免责声明，是事实：取消只改本地状态，支付平台那边的
 * 会话还活着，回调照样会把订单推回 PAID（§13.1 的 CANCELLED → PAID 是合法迁移）。所以先叫人关掉支付页。
 */
async function cancelOrder() {
  if (!order.value || !auth.session.value) return
  if (!confirm(`取消订单 ${productName.value}（${money(order.value.amount_minor, order.value.currency)}）？\n\n如果支付页面还开着，请先关掉：取消后若仍完成付款，订单会重新变为已支付。`)) return
  cancelling.value = true
  cancelMessage.value = ''
  try {
    const response = await fetch('/api/cancel-order', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.session.value.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ order_id: order.value.id })
    })
    const data = await response.json().catch(() => ({}))
    cancelMessage.value = response.ok ? '订单已取消，现在可以重新下单。' : (data.error || `取消失败（${response.status}）`)
    // 重读全部而不是只重读订单：取消会写一条 PENDING → CANCELLED，那条要出现在下面的变更记录里。
    await loadAll()
  } catch (e: any) {
    cancelMessage.value = e.message
  } finally {
    cancelling.value = false
  }
}

/** 订单号显示前 8 位，全长挂在 title 上。买家跟客服对号时用得上全长，而屏幕上一行 uuid 只是噪音。 */
const shortId = computed(() => String(order.value?.id || '').slice(0, 8))
</script>

<template>
<div class="fluent-page">
  <SiteHeader />
  <main class="order-main">
    <a class="back-link" href="/me"><ArrowLeft :size="17" />返回订单列表</a>

    <div v-if="denied" class="fluent-empty denied">
      <ShieldAlert :size="34" />
      <h1>无权访问此订单</h1>
      <p>订单不存在，或不属于当前账户。</p>
    </div>
    <div v-else-if="loading" class="fluent-empty">正在加载订单…</div>

    <template v-else-if="order">
      <section class="order-summary">
        <div>
          <p :title="order.id">ORDER / {{ shortId }}</p>
          <h1>{{ productName }}</h1>
          <span :class="`order-${order.status}`">{{ statusLabel(order.status) }}</span>
        </div>
        <!-- 头部显示实付；没有实付（还没付款）就显示应付。这里只放一个数字，三个金额在下面那张卡里。 -->
        <strong>{{ money(order.paid_amount_minor ?? order.amount_minor, order.paid_currency || order.currency) }}</strong>
      </section>

      <section class="order-detail-grid">
        <article>
          <h2><PackageOpen :size="18" />商品信息</h2>
          <dl>
            <div><dt>构建</dt><dd>{{ order.sku }}</dd></div>
            <div v-if="order.sku_name"><dt>名称</dt><dd>{{ order.sku_name }}</dd></div>
            <div><dt>数量</dt><dd>{{ order.quantity || 1 }}</dd></div>
          </dl>
          <!-- 描述取的是下单那一刻的快照（orders.sku_description）。商品定义后来改了不影响历史订单。 -->
          <p v-if="order.sku_description" class="order-desc">{{ order.sku_description }}</p>
        </article>

        <article>
          <h2><Wallet :size="18" />金额</h2>
          <dl>
            <div><dt>原价</dt><dd>{{ money(order.list_amount_minor ?? order.amount_minor, order.currency) }}</dd></div>
            <div v-if="hasDiscount" class="order-discount">
              <dt><Ticket :size="14" />优惠券</dt>
              <dd>
                <code v-if="order.coupon_code">{{ order.coupon_code }}</code>
                <span>−{{ money(order.discount_minor || 0, order.currency) }}</span>
              </dd>
            </div>
            <div><dt>应付</dt><dd>{{ money(order.amount_minor, order.currency) }}</dd></div>
            <div><dt>实付</dt><dd>{{ money(order.paid_amount_minor, order.paid_currency || order.currency) }}</dd></div>
          </dl>
          <!-- 实付≠应付时说清楚，并且不擅自判断谁对谁错：币种换算、少付、超付都会走到这里。 -->
          <p v-if="paidDiffers" class="order-warn">
            <CircleAlert :size="15" />实付金额与应付金额不一致，如有疑问请联系客服核对。
          </p>
        </article>

        <article>
          <h2><ReceiptText :size="18" />支付信息</h2>
          <dl>
            <div><dt>支付平台</dt><dd>{{ order.provider }}</dd></div>
            <!-- payment_reference 是回调带回来的凭证号；没有它就退回平台订单号，两者都没有就是还没付。 -->
            <div><dt>平台单号</dt><dd>{{ order.payment_reference || order.provider_order_id || '等待支付' }}</dd></div>
            <div><dt>创建时间</dt><dd>{{ when(order.created_at) }}</dd></div>
            <div><dt>支付时间</dt><dd>{{ when(order.paid_at) }}</dd></div>
          </dl>
          <div v-if="order.status === 'pending'" class="order-actions">
            <a v-if="order.checkout_url" class="fluent-primary" :href="order.checkout_url">
              继续付款<ExternalLink :size="16" />
            </a>
            <button class="cancel-order" :disabled="cancelling" @click="cancelOrder">
              <XCircle :size="15" />{{ cancelling ? '取消中…' : '取消订单' }}
            </button>
          </div>
          <p v-if="cancelMessage" class="order-message">{{ cancelMessage }}</p>
          <small v-if="order.status === 'pending'" class="pending-note">
            每个账户同时只能有 1 笔待支付订单。取消这笔后即可购买其他构建。
          </small>
        </article>

        <article class="refund-card">
          <h2><RotateCcw :size="18" />退款</h2>

          <!-- 全部申请都列出来，不只是最新那一条：§13.5 允许被拒后重提，而买家需要看到自己提过几次。 -->
          <div v-for="r in refunds" :key="r.id" class="refund-record">
            <header>
              <span :class="`refund-${r.status}`">{{ refundLabel(r.status) }}</span>
              <!-- 金额可能还没定：§10.2 规定由客服确认，所以在途申请上这一列常常是空的。 -->
              <strong v-if="r.amount_minor">{{ money(r.amount_minor, r.currency || order.currency) }}</strong>
              <small>{{ when(r.created_at) }}</small>
            </header>
            <p>{{ r.reason_detail }}</p>
            <p v-if="r.decision_note" class="refund-note"><b>审批说明</b>{{ r.decision_note }}</p>
            <p v-if="r.execution_note" class="refund-note"><b>执行说明</b>{{ r.execution_note }}</p>
            <div v-if="r.evidence_paths?.length" class="refund-evidence">
              <!-- 桶是私有的，签名 URL 十分钟过期；还没签出来的先显示占位，不显示一张破图。 -->
              <a v-for="p in r.evidence_paths" :key="p" :href="evidenceUrls[p]" target="_blank" rel="noopener">
                <img v-if="evidenceUrls[p]" :src="evidenceUrls[p]" alt="退款证据" loading="lazy" />
                <FileImage v-else :size="18" />
              </a>
            </div>
          </div>
          <!--
            §13.2：能提就给表单，不能提就给一个灰按钮加一句理由。理由来自 canRequestRefund，
            而接口调的是同一个函数，所以这里写的和点下去会收到的是同一句话。
          -->
          <form v-if="refundGate.ok" @submit.prevent="submitRefund">
            <label>退款理由
              <select v-model="reason">
                <option value="duplicate">重复购买</option>
                <option value="not_as_described">与描述不符</option>
                <option value="technical_issue">技术问题</option>
                <option value="other">其他</option>
              </select>
            </label>
            <!-- maxlength 跟接口那条 2000 字对齐。不写 minlength：接口不限下限，写了就是浏览器自己多一道拦。 -->
            <label>详细说明
              <textarea v-model="detail" required rows="5" maxlength="2000"
                placeholder="请说明退款原因。如果希望退部分金额，请在这里写清楚——具体金额由客服确认。"></textarea>
            </label>
            <label class="upload-field">
              <ImagePlus :size="18" />
              <span>上传图片证据（JPG / PNG / WebP，单张 5 MB，最多 {{ EVIDENCE_MAX_COUNT }} 张）</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple @change="pickFiles" />
            </label>
            <ul v-if="files.length" class="refund-files">
              <li v-for="f in files" :key="f.name"><FileImage :size="14" />{{ f.name }}</li>
            </ul>
            <button class="fluent-primary" :disabled="sending">{{ sending ? '正在提交…' : '提交退款申请' }}</button>
          </form>
          <template v-else>
            <button class="fluent-secondary" disabled :title="refundGate.reason">申请退款</button>
            <!-- 理由既挂 title 又写成可见文字：只挂 title 的话触屏和读屏都读不到它。 -->
            <p class="refund-hint"><CircleAlert :size="15" />{{ refundGate.reason }}</p>
          </template>
          <p v-if="message" class="order-message">{{ message }}</p>
        </article>
      </section>

      <!--
        §5 的订单变更记录。note 是管理员手改状态时必填的说明（§12.5），照原样给买家看：
        RLS 本来就让他们读得到这一列，藏起来保护不了任何东西，只会让唯一的解释消失。
      -->
      <section v-if="logs.length" class="order-log">
        <h2>订单变更记录</h2>
        <ol>
          <li v-for="entry in logs" :key="entry.id">
            <b>{{ transitionLabel(entry.from_status, entry.to_status) }}</b>
            <span>{{ SOURCE_LABEL[entry.source] || entry.source }}</span>
            <em v-if="entry.note">{{ entry.note }}</em>
            <small>{{ when(entry.created_at) }}</small>
          </li>
        </ol>
      </section>
    </template>
  </main>
  <SiteFooter />
</div>
</template>

