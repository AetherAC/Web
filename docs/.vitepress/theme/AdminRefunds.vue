<script setup lang="ts">
/**
 * §10.6 退款审批看板。后端是 api/_routes/admin-refunds.mjs，加上四个动作接口
 * （refund-approve / refund-reject / refund-transfer / refund-execute）。
 *
 * 这一页存在的理由：在它之前，§13.3/§13.4 的四个动作只有一个入口——收件箱里那条审批站内信上的按钮。
 * 而 shared/notifications.mjs 的 ACTION_TYPES 里没有 execute_refund，所以「登记退款成功 / 无法退款」
 * 这一对按钮在整个站点里没有任何调用方：申请能批准、能拒绝、能转交，却永远走不到终态。这一页是
 * api/_routes/refund-execute.mjs 的第一个调用方。
 *
 * 三件事故意由服务端决定，前端一行都不算：
 * - 「这条申请现在能点哪些按钮」。actions 数组由 actionsFor() 给，它同时看申请状态和订单状态；前端
 *   照着画。自己算一份的结果是按钮亮着、点下去 409。
 * - 「为什么不能登记退款结果」。execute_block 是一整句中文，直接显示。它要区分的三种情况分别落在
 *   两张表上（申请状态 × 订单状态），而这一页只有其中一张的一部分。
 * - 「该补哪一步」。repair 由 planRepair() 给，连按钮文字和写进审计轨迹的说明都是它给的；提交时把
 *   repair.action 一起发回去让服务端核对——这一页可能已经在屏幕上放了十分钟。
 *
 * 门槛是 rank ≥ 777（客服要能看自己代提的退款走到哪了），四个动作和补齐都只有 admin 能点。
 * can_decide 为 false 时按钮照画、禁用并写明原因（§13.2：可见但不可点）。
 */
import { computed, reactive, ref, watch } from 'vue'
import {
  ChevronLeft, ChevronRight, CircleAlert, Clock, Download, ExternalLink, FileClock, FileImage,
  Gavel, Paperclip, ScrollText, Search, Timer, TriangleAlert, UserRound, Wrench, X
} from 'lucide-vue-next'
import { supabase, useAuth } from './auth'
import { ORDER_STATUS_LABEL, REFUND_STATUSES, REFUND_STATUS_LABEL } from '../../../shared/orders.mjs'
import { formatMinor } from '../../../shared/coupons.mjs'
import { orderPath } from './routes'

const auth = useAuth()

/**
 * 订单管理页跳过来时带的订单号（AdminPage 转发的 open-refunds）。
 *
 * 只作为初始筛选条件用一次，不是受控 prop：进来之后这一页的筛选归用户，父组件不该在他改完之后再把它
 * 按回去。为空就是正常进这一页。
 */
const props = defineProps<{ orderId?: string }>()

/** 默认只看在途的（open = 除已拒绝/已完成/失败之外的四个状态）。看板是干活的地方，不是档案馆。 */
const FILTER_DEFAULTS = { status: 'open', initiator_role: '', order_id: '', user_id: '', overdue: '' }
const filters = reactive({ ...FILTER_DEFAULTS })

/** initiator_role 的取值，和 refund_requests_initiator_role_check 对齐。 */
const ROLE_LABEL: Record<string, string> = {
  user: '用户本人', postsale: '售后客服代提', cs: '客服代提', admin: '管理员代提'
}
/** 买家侧的四个 reason_code，加上客服代提用的那个。cs-actions 不校验这一列，所以要有原文兜底。 */
const REASON_LABEL: Record<string, string> = {
  duplicate: '重复购买', not_as_described: '与描述不符', technical_issue: '技术问题',
  other: '其他', staff_proxy: '客服代提'
}
/**
 * refund_audit_log.action 的中文。库里存的就是这些字面量（全站 logRefundAction 的调用点），escalate 和
 * remind 留给 §10.5 的 pg_cron。取不到就显示原文：审计轨迹缺一行远比显示一个英文字面量严重。
 */
const ACTION_LABEL: Record<string, string> = {
  create: '提交申请',
  approve: '批准',
  order_move_failed: '批准后订单未能变更',
  reject: '拒绝',
  transfer: '转交',
  reopen_after_transfer: '转交后重新待审批',
  edit_amount: '修改退款金额',
  execute_claim: '开始执行',
  execute_success: '登记退款成功',
  execute_failed: '登记无法退款',
  execute_order_move_failed: '执行时订单未能变更',
  repair_order_move: '补齐订单状态',
  repair_settle_completed: '补齐申请状态（已完成）',
  repair_settle_failed: '补齐申请状态（失败）',
  settle_notification: '结果通知',
  escalate: '超时升级',
  remind: '超时提醒'
}

const rows = ref<any[]>([])
const people = ref<Record<string, any>>({})
const counts = ref<any>({ open: 0, overdue: 0, executing: 0, counted: true })
const total = ref(0)
const offset = ref(0)
const pageSize = ref(20)
const canDecide = ref(false)
const timeoutHours = ref(48)
const reminderHours = ref(24)
const requireConfirm = ref(true)
const autoExecute = ref(false)
const loading = ref(false)
const exporting = ref(false)
const message = ref('')

const detail = ref<any>(null)
const detailLoading = ref(false)
const detailMessage = ref('')
const evidenceUrls = ref<Record<string, string>>({})

/** 一次只展开一个动作表单。五个表单同时摊开，填错一个框、点错一个钮的代价是一笔钱。 */
const openAction = ref('')
const formNote = ref('')
const formTo = ref('')
const formAmount = ref<number | null>(null)
const sending = ref(false)
const admins = ref<any[]>([])
const adminsLoading = ref(false)

/** 补齐不是审批动作，所以自己一套状态：它只有一个可选说明，也不需要选人或改金额。 */
const repairNote = ref('')
const repairing = ref(false)

const money = (minor: any, currency?: string | null) =>
  minor === null || minor === undefined || minor === '' ? '—' : formatMinor(minor, currency || 'USD')
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—')
/** 列表里显示前 8 位，全长挂 title。一行 uuid 在表格里只是噪音，但跟渠道对账时要全长。 */
const shortId = (id: string) => String(id || '').slice(0, 8).toUpperCase()
const statusLabel = (s: string) => REFUND_STATUS_LABEL[s] || s || '—'
const orderLabel = (s: string) => ORDER_STATUS_LABEL[s] || s || '—'
const roleLabel = (r: string) => ROLE_LABEL[r] || r || '—'
const reasonLabel = (c: string) => REASON_LABEL[c] || c || '—'
const actionLabel = (a: string) => ACTION_LABEL[a] || a
/**
 * people 里是服务端脱敏过的名字和邮箱。取不到就显示 uuid 前 8 位，而不是「未知用户」——后者会让
 * 「这个人查不到」和「这一行没有操作人（系统写的）」看起来一样，而它们的处置办法完全不同。
 */
function personName(id?: string | null) {
  if (!id) return '系统'
  const who = people.value[id] || detail.value?.people?.[id]
  return who?.name || who?.email || shortId(id)
}
const personEmail = (id?: string | null) =>
  (id && (people.value[id] || detail.value?.people?.[id])?.email) || ''
/** 等待时长由服务端算（waited_hours，它有 created_at 和当前时间），这里只负责说人话。 */
const waited = (hours: any) => {
  const h = Number(hours)
  if (!Number.isFinite(h)) return '—'
  if (h < 1) return '不到 1 小时'
  if (h < 48) return `${Math.floor(h)} 小时`
  return `${Math.floor(h / 24)} 天`
}
const pages = computed(() => Math.max(1, Math.ceil(total.value / (pageSize.value || 20))))
const page = computed(() => Math.floor(offset.value / (pageSize.value || 20)) + 1)

/**
 * 五个动作的全部差异收在这张表里，key 就是后端 actions 数组里的字符串。别处不再判断动作类型。
 *
 * confirmable 的三个动作会先弹一次浏览器确认，再把 confirm:true 发上去。即使 §14 的
 * refund_require_second_confirm 关着也照弹：登记退款成功之后 refunded 是终态
 * （ORDER_TRANSITIONS.refunded 是空数组），点错没有回头路，而那个开关管的是服务端要不要拦，
 * 不是这一步是否可逆。拒绝故意不弹——它是可逆的（用户能重新提一条），而每个动作都弹会让人养成
 * 一路点确定的习惯，代价落在真正不可逆的那一个上。
 */
const ACTION_SPEC: Record<string, any> = {
  approve: {
    label: '批准退款', primary: true, endpoint: '/api/refund-approve',
    noteLabel: '审批说明（可留空）', noteRequired: false, amount: true, confirmable: true,
    hint: '批准之后订单进入「退款中」，用户收到站内信。这一步不动钱——你还要到渠道后台把钱退出去，再回来登记结果。',
    confirmText: (r: any) => `批准这条退款申请（${money(r.amount_minor, r.currency)}）？\n\n订单会立刻变成「退款中」，用户会收到一封站内信。这一步不动钱：钱要你到渠道后台退，退完再回来登记结果。`
  },
  reject: {
    label: '拒绝退款', endpoint: '/api/refund-reject',
    noteLabel: '拒绝理由（必填）', noteRequired: true,
    hint: '理由会原样出现在用户收到的站内信里。订单留在「已支付」，用户可以再提一次。'
  },
  transfer: {
    label: '转交其他管理员', endpoint: '/api/refund-transfer',
    noteLabel: '转交说明（必填）', noteRequired: true, needTarget: true,
    hint: '转交后申请回到「待审批」。等待时长仍从提交那一刻算起，不会因为转交而清零。'
  },
  execute_success: {
    label: '登记退款成功', primary: true, endpoint: '/api/refund-execute', body: { outcome: 'success' },
    noteLabel: '执行备注（可留空）', noteRequired: false, confirmable: true,
    hint: '意思是「我已经在渠道后台退完了，现在来登记」。系统拿不到任何渠道退款凭据，所以这一步只能人手点。',
    confirmText: (r: any) => `确认这笔 ${money(r.amount_minor, r.currency)} 已经在渠道后台退给用户了？\n\n订单会变成「已退款」，而「已退款」是终态——点下去没有回头路。如果钱还没退出去，请先去渠道后台。`
  },
  execute_failed: {
    label: '登记无法退款', endpoint: '/api/refund-execute', body: { outcome: 'failed' },
    noteLabel: '失败原因（必填）', noteRequired: true, confirmable: true,
    hint: '订单退回「已支付」，申请标为失败。之后换个渠道退成了，还可以再点一次「登记退款成功」。',
    confirmText: () => '登记为无法退款？\n\n订单会退回「已支付」，用户会收到一封写着你填的原因的站内信。这一步可以重做：之后退成了再点「登记退款成功」。'
  }
}

/**
 * 状态码要能被调用方看到：428 和 409 的处置办法完全不同（补一次确认 / 重读之后重来），
 * 而只有一句中文错误信息的话，前端只能去匹配文案。
 */
async function api(path: string, options: any = {}) {
  const token = auth.session.value?.access_token
  const r = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const err: any = new Error(data.error || `请求失败（${r.status}）`)
    err.status = r.status
    err.data = data
    throw err
  }
  return data
}

/** 只把填了的条件拼进 query。overdue 是 checkbox，值是 '1' 或空串。 */
function queryString(extra: Record<string, string> = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (String(value ?? '').trim()) params.set(key, String(value))
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  return params.toString()
}

async function load(nextOffset = offset.value) {
  loading.value = true
  message.value = ''
  try {
    const data = await api(`/api/admin-refunds?${queryString({ offset: String(nextOffset) })}`)
    rows.value = data.refunds || []
    people.value = data.people || {}
    counts.value = data.counts || { counted: false }
    total.value = data.total || 0
    offset.value = data.offset || 0
    // limit 是后端夹过上限之后的实际每页条数；page_size 是配置值。翻页要用前者，否则最后一页会跳空。
    pageSize.value = data.limit || data.page_size || 20
    canDecide.value = Boolean(data.can_decide)
    timeoutHours.value = Number(data.timeout_hours) || 48
    reminderHours.value = Number(data.reminder_interval_hours) || 24
    requireConfirm.value = data.require_confirm !== false
    autoExecute.value = Boolean(data.auto_execute)
    if (!rows.value.length) message.value = total.value ? '这一页没有记录，请回到第一页' : '没有符合条件的退款申请'
  } catch (e: any) {
    rows.value = []
    total.value = 0
    counts.value = { counted: false }
    message.value = e.message
  } finally {
    loading.value = false
  }
}

/** 改了条件就回第一页。留在第 7 页上换条件，结果通常是一个空列表加一句「没有符合条件的申请」。 */
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
/** 头上那三个数点一下就是一个筛选条件——看板的用处是「看到积压之后能立刻翻到它」。 */
function focusCount(kind: 'open' | 'overdue' | 'executing') {
  Object.assign(filters, FILTER_DEFAULTS)
  if (kind === 'overdue') { filters.status = 'pending'; filters.overdue = '1' }
  if (kind === 'executing') filters.status = 'executing'
  return load(0)
}

/**
 * 凭据在私有桶里，浏览器拿不到直链。refund-evidence 的 select 策略里有 private.is_staff()，所以这一页
 * 签得出别人上传的图；600 秒足够看完，过期了重新打开详情会再签一次。
 */
async function signEvidence(path: string) {
  if (!supabase || evidenceUrls.value[path]) return
  const { data } = await supabase.storage.from('refund-evidence').createSignedUrl(path, 600)
  if (data?.signedUrl) evidenceUrls.value = { ...evidenceUrls.value, [path]: data.signedUrl }
}
const isImage = (path: string) => /\.(png|jpe?g|webp)$/i.test(String(path || ''))

async function openDetail(id: string) {
  detailLoading.value = true
  detailMessage.value = ''
  openAction.value = ''
  formNote.value = ''
  formTo.value = ''
  formAmount.value = null
  repairNote.value = ''
  try {
    const data = await api(`/api/admin-refunds?refund_id=${encodeURIComponent(id)}`)
    detail.value = data
    for (const path of data.refund?.evidence_paths || []) void signEvidence(path)
  } catch (e: any) {
    detail.value = null
    message.value = e.message
  } finally {
    detailLoading.value = false
  }
}
const closeDetail = () => { detail.value = null; detailMessage.value = ''; openAction.value = '' }

/**
 * 转交对象。来源和 InboxPage.vue 一样：/api/admin-users 里 group_name === 'admin' 且不是自己。
 * 只在转交表单打开时才拉——这是个 admin 门槛的接口，而翻看板的人多半根本不会转交。
 */
async function loadAdmins() {
  if (admins.value.length || adminsLoading.value) return
  adminsLoading.value = true
  try {
    const data = await api('/api/admin-users')
    admins.value = (data.users || []).filter((u: any) =>
      u.group_name === 'admin' && u.user_id !== auth.user.value?.id)
    if (!admins.value.length) detailMessage.value = '除你之外没有别的管理员，这条申请没法转交。'
  } catch (e: any) {
    detailMessage.value = e.message
  } finally {
    adminsLoading.value = false
  }
}

function toggleAction(key: string) {
  if (openAction.value === key) { openAction.value = ''; return }
  openAction.value = key
  formNote.value = ''
  formTo.value = ''
  // 金额预填申请的金额：§10.2 允许改，但绝大多数批准是照原样批的，空着会让人以为这是必填项。
  formAmount.value = ACTION_SPEC[key]?.amount ? (detail.value?.refund?.amount_minor ?? null) : null
  detailMessage.value = ''
  if (ACTION_SPEC[key]?.needTarget) void loadAdmins()
}

/** 「请填写×××」里的那三个字，从 noteLabel 上把括号去掉得到，免得两处文案各写一遍。 */
const bareLabel = (label: string) => String(label || '').replace(/（.*?）$/, '')

/**
 * 五个动作走同一条路：必填校验、二次确认、发请求、重读。请求体的差异全在 ACTION_SPEC 里。
 *
 * 重读是列表和详情都读：申请状态变了，列表那一行的状态和头上那三个计数都会跟着变，而看板的用处
 * 正是那三个数。
 */
async function submitAction(key: string) {
  const spec = ACTION_SPEC[key]
  const refund = detail.value?.refund
  if (!spec || !refund) return
  const note = formNote.value.trim()
  if (spec.noteRequired && !note) { detailMessage.value = `请填写${bareLabel(spec.noteLabel)}`; return }
  if (spec.needTarget && !formTo.value) { detailMessage.value = '请选择转交给谁'; return }

  const body: any = { refund_id: refund.id, ...(spec.body || {}) }
  if (note) body.note = note
  if (spec.needTarget) body.transfer_to = formTo.value
  // 金额只在改过的时候发。validateRefundAmount 只收整数 number，字符串会被它响亮拒掉。
  //
  // 空输入框在 v-model.number 下是空字符串，不是 null——Number('') 是 0，而 0 会被服务端拒成
  // 「退款金额必须大于 0」。所以这里要单独把空串挡掉，否则清空这个框等于提交一个非法金额。
  if (spec.amount) {
    const wanted = formAmount.value
    const rounded = Math.round(Number(wanted))
    const filled = wanted !== null && wanted !== undefined && String(wanted).trim() !== ''
    if (filled && Number.isFinite(rounded) && rounded > 0 && rounded !== refund.amount_minor) {
      body.amount_minor = rounded
    }
  }
  if (spec.confirmable) {
    if (!confirm(spec.confirmText(refund))) return
    body.confirm = true
  }

  sending.value = true
  detailMessage.value = ''
  try {
    const data = await api(spec.endpoint, { method: 'POST', body: JSON.stringify(body) })
    openAction.value = ''
    await Promise.all([openDetail(refund.id), load()])
    detailMessage.value = resultMessage(key, data)
  } catch (e: any) {
    const text = e.status === 428
      ? `${e.message}。这一页本来会先弹一次确认，收到这个错说明确认没发上去——请刷新后重试。`
      : e.message
    // 409 的成因几乎总是「你看这一页的时候状态被别人或回调改了」。先重读再写错误：顺序反了的话
    // openDetail 开头那句清空会把刚写上的这一句抹掉。
    if (e.status === 409) await Promise.all([openDetail(refund.id), load()])
    detailMessage.value = text
  } finally {
    sending.value = false
  }
}

/**
 * 如实回报。order_moved / notified / status 三个字段为「没成」时都不能粉饰成成功：那意味着两段写入
 * 只成了一段，而剩下那一段要靠人点「补齐」，看不到这句话的人不会知道还有一步没做。
 */
function resultMessage(key: string, data: any) {
  const tail = data.notified === false ? '结果站内信没能写进去，请另行告知用户。' : '用户已收到站内信。'
  if (key === 'approve') {
    if (data.order_moved === false) {
      return `申请已批准，但订单没能改成「退款中」（当前是「${orderLabel(data.order_status)}」）。请用下面的「补齐订单状态」把它补上，补齐之前不能登记退款结果。`
    }
    return data.auto_execute
      ? '申请已批准，订单已进入「退款中」。§14 的自动执行是开着的，系统会自己往下走。'
      : '申请已批准，订单已进入「退款中」。钱还要你到渠道后台退，退完回来登记结果。'
  }
  if (key === 'reject') return `已拒绝，订单留在「已支付」。${tail}`
  if (key === 'transfer') {
    return `已转交给 ${data.transferred_to_name || personName(data.transferred_to)}，申请回到「待审批」。${tail}`
  }
  if (key === 'execute_success') {
    return data.status === 'completed'
      ? `已登记退款成功，订单已是「已退款」。${tail}`
      : `订单已改成「已退款」，但申请没落到「已完成」（还停在「执行中」）。${tail}请用下面的「补齐申请状态」把它补上。`
  }
  if (key === 'execute_failed') {
    return data.status === 'failed'
      ? `已登记为无法退款，订单退回「已支付」。${tail}`
      : `订单已退回「已支付」，但申请没落到「失败」（还停在「执行中」）。${tail}请用下面的「补齐申请状态」把它补上。`
  }
  return '操作完成'
}

/**
 * §10.7 的补齐。planRepair() 已经给了 kind / action / label / note，这里只是把 action 一起发回去让
 * 服务端核对——看板可能已经在屏幕上放了十分钟，期间别人可能已经补过了，那时服务端回 409 并说明
 * 现在该看哪一步。
 */
async function submitRepair() {
  const refund = detail.value?.refund
  const plan = refund?.repair
  if (!plan) return
  if (!confirm(`${plan.label}？\n\n这一步只把上次没落地的那次状态变更补上：不动钱、不给用户发站内信，会记进审计轨迹。`)) return
  repairing.value = true
  detailMessage.value = ''
  const body: any = { action_kind: 'repair', refund_id: refund.id, action: plan.action }
  if (repairNote.value.trim()) body.note = repairNote.value.trim()
  try {
    await api('/api/admin-refunds', { method: 'POST', body: JSON.stringify(body) })
    await Promise.all([openDetail(refund.id), load()])
    detailMessage.value = `已${bareLabel(plan.label)}，审计轨迹里能看到这一条。`
  } catch (e: any) {
    const text = e.message
    if (e.status === 409) await Promise.all([openDetail(refund.id), load()])
    detailMessage.value = text
  } finally {
    repairing.value = false
  }
}

/**
 * §10.8 的审计导出。不能做成 <a href>：这个接口要 Authorization 头，而浏览器导航不带它——那样点下去
 * 下载到的是一个内容为 {"error":"Authentication required"} 的 csv 文件。所以 fetch 成 blob 再触发下载。
 *
 * 一行一个审计事件，不是一行一条申请：§10.8 要的是经过，不是结果。
 */
async function exportCsv() {
  exporting.value = true
  message.value = ''
  try {
    const r = await fetch(`/api/admin-refunds?${queryString({ view: 'export' })}`, {
      headers: { Authorization: `Bearer ${auth.session.value?.access_token}` }
    })
    if (!r.ok) {
      const data = await r.json().catch(() => ({}))
      throw new Error(data.error || `导出失败（${r.status}）`)
    }
    const url = URL.createObjectURL(await r.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || 'refund-audit.csv'
    link.click()
    // 立刻 revoke 会让部分浏览器来不及取到内容，晚几秒再放。
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    const totalRefunds = r.headers.get('X-Export-Total')
    // 被上限截断时必须说出来：不说的话，拿这份表去复盘的人会以为这个筛选条件下就这么多申请。
    message.value = r.headers.get('X-Export-Truncated') === '1'
      ? `符合条件的共 ${totalRefunds} 条申请，只导出了前 2000 条——请缩小条件后分批导出。`
      : `已导出 ${totalRefunds} 条申请的全部审计事件`
  } catch (e: any) {
    message.value = e.message
  } finally {
    exporting.value = false
  }
}

watch(() => auth.ready.value, ready => {
  if (!ready || !auth.user.value) return
  // 从订单页跳过来时连状态筛选一起清掉：那笔订单上的申请可能已经完成或被拒，而默认的 status='open'
  // 恰好会把这两种藏起来——点了「到退款审批看板处理这笔」却看到空列表，比不给这个入口更难解释。
  if (props.orderId) { filters.order_id = props.orderId; filters.status = '' }
  void load(0)
}, { immediate: true })
</script>

<template>
<div class="orders-pane refunds-pane">
  <!-- §10.6 顶上那三个数。counted 为 false 是「这三个数没查出来」，此时显示「—」而不是 0——0 的
       意思是「没有积压」，那是另一回事，而看板正是用来判断有没有积压的。 -->
  <section class="refund-counts">
    <button type="button" :disabled="!counts.counted || loading" @click="focusCount('open')">
      <Clock :size="18" /><b>{{ counts.counted ? counts.open : '—' }}</b><span>在途申请</span>
    </button>
    <button
      type="button" :class="{ alert: counts.counted && counts.overdue > 0 }"
      :disabled="!counts.counted || loading" @click="focusCount('overdue')">
      <Timer :size="18" /><b>{{ counts.counted ? counts.overdue : '—' }}</b><span>超过 {{ timeoutHours }} 小时未审批</span>
    </button>
    <button
      type="button" :class="{ alert: counts.counted && counts.executing > 0 }"
      :disabled="!counts.counted || loading" @click="focusCount('executing')">
      <Wrench :size="18" /><b>{{ counts.counted ? counts.executing : '—' }}</b><span>卡在执行中</span>
    </button>
  </section>
  <p v-if="!counts.counted" class="orders-hint">
    <CircleAlert :size="15" />这三个数没能查出来，所以显示的是「—」。列表本身不受影响。
  </p>
  <p v-if="autoExecute" class="orders-hint refund-hint">
    <CircleAlert :size="15" />§14 的「退款自动执行」是开着的：批准之后系统会自己往下走，「登记退款成功」通常不该由你手工点。
  </p>

  <!-- 整块是一个 form，所以在任何输入框里按回车都等于点「查询」。 -->
  <form class="orders-filters" @submit.prevent="search()">
    <label>申请状态
      <select v-model="filters.status">
        <option value="open">在途（待审批 / 已批准 / 已转交 / 执行中）</option>
        <option value="">全部</option>
        <option v-for="s in REFUND_STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
      </select>
    </label>
    <label>发起人
      <select v-model="filters.initiator_role">
        <option value="">全部</option>
        <option v-for="(label, role) in ROLE_LABEL" :key="role" :value="role">{{ label }}</option>
      </select>
    </label>
    <label>订单号<input v-model="filters.order_id" type="search" placeholder="00000000-0000-0000-0000-000000000000" /></label>
    <label>用户 ID<input v-model="filters.user_id" type="search" placeholder="00000000-0000-0000-0000-000000000000" /></label>
    <label class="wide refund-check">
      <input v-model="filters.overdue" type="checkbox" true-value="1" false-value="" />
      <span>只看超过 {{ timeoutHours }} 小时还没审批的</span>
      <button class="fluent-primary" :disabled="loading"><Search :size="16" />查询</button>
    </label>
  </form>

  <div class="orders-bar">
    <span>
      共 {{ total }} 条 · 第 {{ page }} / {{ pages }} 页
      <template v-if="!canDecide"> · 只读：审批、转交和登记退款结果需要管理员</template>
    </span>
    <span class="toolbar-actions">
      <button :disabled="offset <= 0 || loading" @click="turnPage(-1)"><ChevronLeft :size="16" />上一页</button>
      <button :disabled="offset + pageSize >= total || loading" @click="turnPage(1)">下一页<ChevronRight :size="16" /></button>
      <button :disabled="exporting || loading" @click="exportCsv">
        <Download :size="16" />{{ exporting ? '正在导出…' : '导出审计轨迹' }}
      </button>
      <button :disabled="loading" @click="resetFilters"><X :size="16" />清空条件</button>
    </span>
  </div>

  <div v-if="loading" class="fluent-empty">正在加载退款申请…</div>
  <div v-else class="orders-table refunds-table order-table">
    <header><span>申请号</span><span>提交 / 等待</span><span>用户</span><span>金额</span><span>发起人</span><span>订单</span><span>状态</span></header>
    <!-- 行做成 button 而不是 div：键盘要能 Tab 过来按回车，读屏也要知道这一行是可点的。 -->
    <button
      v-for="r in rows" :key="r.id" type="button"
      :class="{ selected: detail?.refund?.id === r.id, 'row-overdue': r.overdue }" @click="openDetail(r.id)">
      <span :title="r.id"><b>{{ shortId(r.id) }}</b><small>订单 {{ shortId(r.order_id) }}</small></span>
      <span>
        <b>{{ when(r.created_at) }}</b>
        <small>已等 {{ waited(r.waited_hours) }}<template v-if="r.overdue"> · 已超时</template></small>
      </span>
      <!-- 名字和邮箱都是服务端脱敏过的（maskTail / maskEmail），这一页拿不到完整地址。 -->
      <span :title="r.user_id">
        <b>{{ people[r.user_id]?.name || shortId(r.user_id) }}</b>
        <small>{{ people[r.user_id]?.email || '邮箱未记录' }}</small>
      </span>
      <span>
        <b>{{ money(r.amount_minor, r.currency) }}</b>
        <small v-if="r.order_paid_minor !== null && r.order_paid_minor !== undefined">实付 {{ money(r.order_paid_minor, r.currency) }}</small>
      </span>
      <span>
        <b>{{ roleLabel(r.initiator_role) }}</b>
        <!-- 转交过的申请要看得出在等谁，否则它和没人管的那些长得一模一样。 -->
        <small v-if="r.waiting_on">等 {{ personName(r.waiting_on) }}</small>
        <small v-else-if="r.overdue">等全体管理员</small>
      </span>
      <span>
        <b>{{ r.order_sku_name || '—' }}</b>
        <small :class="`order-${r.order_status}`">{{ orderLabel(r.order_status) }}</small>
      </span>
      <span>
        <em :class="`refund-${r.status}`">{{ statusLabel(r.status) }}</em>
        <small v-if="r.repair">待补齐</small>
      </span>
    </button>
  </div>
  <p v-if="message" class="admin-message">{{ message }}</p>

  <div v-if="detailLoading" class="fluent-empty">正在加载退款详情…</div>
  <template v-else-if="detail">
    <section class="order-summary orders-detail-head">
      <div>
        <p :title="detail.refund.id">REFUND / {{ shortId(detail.refund.id) }}</p>
        <h1>{{ detail.order?.sku_name || detail.refund.order_sku_name || '退款申请' }}</h1>
        <span :class="`refund-${detail.refund.status}`">{{ statusLabel(detail.refund.status) }}</span>
      </div>
      <strong>{{ money(detail.refund.amount_minor, detail.refund.currency) }}</strong>
      <button class="icon-button" title="关闭详情" @click="closeDetail"><X :size="18" /></button>
    </section>

    <div class="order-detail-grid">
      <article>
        <h2><FileClock :size="18" />申请信息</h2>
        <dl>
          <div><dt>申请号</dt><dd><code class="orders-uuid">{{ detail.refund.id }}</code></dd></div>
          <div><dt>退款金额</dt><dd>{{ money(detail.refund.amount_minor, detail.refund.currency) }}</dd></div>
          <div><dt>发起人</dt><dd>{{ roleLabel(detail.refund.initiator_role) }}<template v-if="detail.refund.initiated_by"> · {{ personName(detail.refund.initiated_by) }}</template></dd></div>
          <div><dt>原因</dt><dd>{{ reasonLabel(detail.refund.reason_code) }}</dd></div>
          <div><dt>提交时间</dt><dd>{{ when(detail.refund.created_at) }}</dd></div>
          <div :class="{ 'refund-overdue': detail.refund.overdue }">
            <dt>已等待</dt>
            <dd>{{ waited(detail.refund.waited_hours) }}<template v-if="detail.refund.overdue"> · 已超过 {{ timeoutHours }} 小时</template></dd>
          </div>
          <div v-if="detail.refund.decided_by"><dt>决定人</dt><dd>{{ personName(detail.refund.decided_by) }} · {{ when(detail.refund.decided_at) }}</dd></div>
          <div v-if="detail.refund.transferred_to"><dt>已转交给</dt><dd>{{ personName(detail.refund.transferred_to) }}</dd></div>
          <div v-if="detail.refund.executed_at"><dt>执行时间</dt><dd>{{ when(detail.refund.executed_at) }}</dd></div>
        </dl>
        <p v-if="detail.refund.reason_detail" class="order-desc">{{ detail.refund.reason_detail }}</p>
        <p v-if="detail.refund.decision_note" class="refund-note"><b>审批说明</b>{{ detail.refund.decision_note }}</p>
        <p v-if="detail.refund.execution_note" class="refund-note"><b>执行备注</b>{{ detail.refund.execution_note }}</p>
        <p v-if="detail.refund.admin_note" class="refund-note"><b>管理员备注</b>{{ detail.refund.admin_note }}</p>
      </article>

      <article>
        <h2><UserRound :size="18" />用户与订单</h2>
        <dl>
          <div><dt>用户</dt><dd>{{ personName(detail.refund.user_id) }}</dd></div>
          <!-- 邮箱在服务端就打了码。想看完整邮箱去「用户管理」，那一页门槛是 admin。 -->
          <div><dt>联系邮箱</dt><dd>{{ personEmail(detail.refund.user_id) || '—' }}</dd></div>
          <div><dt>用户 ID</dt><dd><code class="orders-uuid">{{ detail.refund.user_id }}</code></dd></div>
          <div><dt>订单号</dt><dd><code class="orders-uuid">{{ detail.refund.order_id }}</code></dd></div>
          <div><dt>订单状态</dt><dd><em :class="`order-${detail.order?.status}`">{{ detail.order?.status_label || orderLabel(detail.refund.order_status) }}</em></dd></div>
          <div><dt>商品</dt><dd>{{ detail.order?.sku_name || detail.order?.sku || '—' }}</dd></div>
          <div><dt>实付</dt><dd>{{ money(detail.order?.paid_amount_minor ?? detail.order?.amount_minor, detail.order?.paid_currency || detail.refund.currency) }}</dd></div>
        </dl>
        <p><a class="refund-order-link" :href="orderPath(detail.refund.order_id)" target="_blank" rel="noopener"><ExternalLink :size="15" />打开这笔订单的页面</a></p>
      </article>

      <article class="refund-actions">
        <h2><Gavel :size="18" />审批与执行</h2>
        <p v-if="!detail.can_decide" class="orders-hint">
          <CircleAlert :size="15" />只有管理员可以审批、转交和登记退款结果。按钮列在这里是为了让你知道这条申请现在该由谁做什么，对你是禁用的。
        </p>
        <!-- 按钮完全由服务端的 actions 数组决定。前端不自己算「现在能点什么」：那要同时判申请状态和
             订单状态，两份判断迟早分叉，而分叉的表现是按钮亮着、点下去 409。 -->
        <div class="refund-buttons">
          <button
            v-for="key in (detail.refund.actions || [])" :key="key" type="button"
            :class="[ACTION_SPEC[key]?.primary ? 'fluent-primary' : 'fluent-secondary', { active: openAction === key }]"
            :disabled="!detail.can_decide || sending" @click="toggleAction(key)">
            {{ ACTION_SPEC[key]?.label || key }}
          </button>
        </div>
        <p v-if="!(detail.refund.actions || []).length" class="orders-hint">
          <CircleAlert :size="15" />这条申请已经是「{{ statusLabel(detail.refund.status) }}」，没有可做的动作了。
        </p>
        <!-- execute_block 是服务端写好的一整句话：它要区分的三种情况分别落在两张表上。 -->
        <p v-if="detail.refund.execute_block" class="orders-hint refund-hint">
          <TriangleAlert :size="15" />{{ detail.refund.execute_block }}
        </p>

        <form v-if="openAction && ACTION_SPEC[openAction]" class="orders-change" @submit.prevent="submitAction(openAction)">
          <p class="refund-form-hint">{{ ACTION_SPEC[openAction].hint }}</p>
          <label v-if="ACTION_SPEC[openAction].needTarget">转交给
            <select v-model="formTo" :disabled="adminsLoading">
              <option value="">{{ adminsLoading ? '正在读取管理员名单…' : '请选择管理员' }}</option>
              <option v-for="u in admins" :key="u.user_id" :value="u.user_id">
                {{ u.display_name || u.email || shortId(u.user_id) }}
              </option>
            </select>
          </label>
          <label v-if="ACTION_SPEC[openAction].amount">
            退款金额（最小货币单位）
            <input v-model.number="formAmount" type="number" min="1" step="1" />
            <!-- 只在改过的时候才发给服务端；上限是实付，超了会被 validateRefundAmount 拒掉。 -->
            <small>{{ money(formAmount, detail.refund.currency) }} · 上限是实付 {{ money(detail.order?.paid_amount_minor ?? detail.order?.amount_minor, detail.order?.paid_currency || detail.refund.currency) }}，改了才会发给服务端。</small>
          </label>
          <label>{{ ACTION_SPEC[openAction].noteLabel }}
            <textarea
              v-model="formNote" rows="3" maxlength="2000" :required="ACTION_SPEC[openAction].noteRequired"
              placeholder="这句话会进审计轨迹。拒绝和登记无法退款时，它还会原样出现在用户收到的站内信里。"></textarea>
            <small>{{ formNote.length }}/2000</small>
          </label>
          <button :class="ACTION_SPEC[openAction].primary ? 'fluent-primary' : 'fluent-secondary'" :disabled="sending">
            {{ sending ? '提交中…' : ACTION_SPEC[openAction].label }}
          </button>
        </form>

        <!-- §10.7：上一次的两段写入只成了一段。补齐把没落地的那一段补上，不动钱、不发站内信。 -->
        <div v-if="detail.refund.repair" class="refund-repair">
          <h3><Wrench :size="16" />{{ detail.refund.repair.label }}</h3>
          <p>{{ detail.refund.repair.note }}。这一步只补状态：不动钱、不给用户发站内信，会记进审计轨迹。</p>
          <label>补充说明（可留空）
            <input v-model="repairNote" type="text" maxlength="2000" placeholder="为什么会需要补齐，例如「批准时接口超时」。" />
          </label>
          <button class="fluent-secondary" :disabled="!detail.can_decide || repairing" @click="submitRepair">
            {{ repairing ? '提交中…' : detail.refund.repair.label }}
          </button>
        </div>
        <p v-if="detailMessage" class="admin-message">{{ detailMessage }}</p>
      </article>

      <article v-if="(detail.refund.evidence_paths || []).length">
        <h2><Paperclip :size="18" />凭据（{{ detail.refund.evidence_paths.length }}）</h2>
        <div class="refund-evidence">
          <a
            v-for="p in detail.refund.evidence_paths" :key="p"
            :href="evidenceUrls[p]" target="_blank" rel="noopener" :title="p">
            <img v-if="evidenceUrls[p] && isImage(p)" :src="evidenceUrls[p]" alt="退款凭据" />
            <FileImage v-else :size="18" />
          </a>
        </div>
        <p class="orders-hint">
          <CircleAlert :size="15" />凭据放在私有存储桶里，这里的链接是临时签出来的，10 分钟后失效——重新打开详情会再签一次。
        </p>
      </article>
    </div>

    <section class="order-log refund-audit">
      <h2>审计轨迹（{{ (detail.logs || []).length }}）</h2>
      <!-- 正序：一条申请的经过要从头读起，而列表是倒序（先看到最新的申请）。 -->
      <ol v-if="(detail.logs || []).length">
        <li v-for="l in detail.logs" :key="l.id">
          <b>{{ actionLabel(l.action) }}</b>
          <span>{{ personName(l.actor_id) }}</span>
          <span v-if="l.from_status !== l.to_status">{{ statusLabel(l.from_status) }} → {{ statusLabel(l.to_status) }}</span>
          <span v-if="l.amount_minor !== null && l.amount_minor !== undefined">{{ money(l.amount_minor, detail.refund.currency) }}</span>
          <em v-if="l.note">{{ l.note }}</em>
          <small>{{ when(l.created_at) }}</small>
        </li>
      </ol>
      <p v-else class="orders-hint">
        <CircleAlert :size="15" />这条申请没有审计记录。创建时那一行本该总是有的，缺了说明当时写入失败过。
      </p>
    </section>
  </template>

  <p class="orders-hint refund-foot">
    <ScrollText :size="15" />超时的判定是「待审批超过 {{ timeoutHours }} 小时」，之后每 {{ reminderHours }} 小时提醒一次（§14 的两个配置，改了立刻生效）。二次确认{{ requireConfirm ? '是开着的：这一页先弹一次，服务端还会再拦一次' : '是关着的：服务端不再拦，但这一页仍然会问一次——不可逆的那一步不该只靠一个开关' }}。
  </p>
</div>
</template>
