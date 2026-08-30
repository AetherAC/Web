<script setup lang="ts">
/**
 * §1 优惠券管理。后端是 api/_routes/admin-coupons.mjs，条件和动作的定义、校验、中文描述全部来自
 * shared/coupons.mjs——前端不自己写一份。
 *
 * 几个刻意的选择：
 * - 条件和动作用「一行一条」的构建器，不是一个 JSON 文本框。JSON 框对写的人友好，对第二个人不友好：
 *   一条 op 拼错的条件会安静落库，然后在某个用户的结算页上被判为「不成立」——券永远用不了，而后台
 *   看着一切正常。构建器让 op 只能从枚举里选。
 * - 保存时只发改动过的字段。整张券回传的话，两个客服同时编辑同一张券时，后保存的那个会把前一个的
 *   改动覆盖成自己打开页面时的旧值（后端的 PATCH 支持部分字段就是为了这个）。
 * - 折扣试算就在旁边。动作是顺序敏感的（「先减 10 再打 9 折」≠「先打 9 折再减 10」），光看列表看不
 *   出来，所以用 applyActions 当场把每一步算出来——用的是核销时的同一个函数。
 * - 已经被用过的券，券码 / 条件 / 动作在界面上就是禁用的，并写明原因。后端也会 409，但让人填完一整
 *   张表单再告诉他不能存是没必要的。
 *
 * 门槛：看、建、改是 staff（§1.1 管理员和客服都能发券），删只有 admin——coupon_redemptions 是
 * on delete cascade，删一张用过的券会把订单折扣的唯一凭据一起带走。要下架请停用。
 */
import { computed, ref, watch } from 'vue'
import { BadgePercent, CircleAlert, Plus, Save, Trash2, X } from 'lucide-vue-next'
import { GROUP_LABEL, GROUP_ORDER, useAuth } from './auth'
import {
  ACTION_TYPES, AMOUNT_OPERATORS, CONDITION_TYPES, ORDER_STATUSES, SKU_OPERATORS,
  applyActions, describeAction, describeCondition, formatMinor, validateCoupon
} from '../../../shared/coupons.mjs'
import { ORDER_STATUS_LABEL } from '../../../shared/orders.mjs'

const auth = useAuth()

const CONDITION_LABEL: Record<string, string> = {
  amount: '订单金额', sku: '商品 SKU', order_history: '历史订单数', first_order: '是否首单', user_group: '用户组'
}
const ACTION_LABEL: Record<string, string> = { delta: '金额增减', percent: '按比例打折', fixed: '固定减免' }
const OP_LABEL: Record<string, string> = { gt: '大于', gte: '不低于', lt: '小于', lte: '不高于', eq: '等于', neq: '不等于' }
const SKU_OP_LABEL: Record<string, string> = {
  is: '等于', is_not: '不等于', contains: '包含', not_contains: '不包含', starts_with: '以…开头', ends_with: '以…结尾'
}

/** 新增一条时的初值。每种类型都给一组能通过校验的默认值，省得刚加一行就先看到一句报错。 */
function blankCondition(type: string): any {
  if (type === 'amount') return { type, op: 'gte', value: 10000, currency: 'USD' }
  if (type === 'sku') return { type, op: 'is', value: '' }
  if (type === 'order_history') return { type, statuses: ['paid'], op: 'gte', count: 1 }
  if (type === 'first_order') return { type, value: true }
  return { type: 'user_group', groups: ['default'] }
}
const blankAction = (type: string): any =>
  type === 'percent' ? { type, value: 9000 } : type === 'fixed' ? { type, value: 1000 } : { type: 'delta', value: -1000 }

const rows = ref<any[]>([])
const selected = ref<any>(null)
const isNew = ref(false)
const loading = ref(false)
const saving = ref(false)
const message = ref('')
const form = ref<any>(emptyForm())
const previewAmount = ref(10000)
const previewCurrency = ref('USD')

function emptyForm() {
  return {
    code: '', name: '', description: '', enabled: true,
    starts_at: '', ends_at: '', per_user_limit: '', total_limit: '',
    allowed_user_ids: '', conditions: [] as any[], actions: [blankAction('percent')] as any[]
  }
}

/** ISO → datetime-local 需要的本地时间字符串。用 getTimezoneOffset 而不是 toISOString().slice()：
 *  后者给的是 UTC，一个北京时间晚上八点开始的券会显示成中午十二点。 */
function toLocalInput(iso?: string | null) {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)
/** 比较到分钟：datetime-local 只有分钟，原值可能带秒，直接比字符串会得到一个不存在的改动。 */
const sameTime = (a: any, b: any) => {
  const ta = a ? Math.floor(new Date(a).getTime() / 60000) : null
  const tb = b ? Math.floor(new Date(b).getTime() / 60000) : null
  return ta === tb
}
const limitIn = (v: any) => (v === null || v === undefined ? '' : String(v))
const limitOut = (v: any) => (String(v ?? '').trim() === '' ? null : Number(v))
const idsIn = (list: any) => (Array.isArray(list) ? list.join('\n') : '')
const idsOut = (text: string) => String(text || '').split(/[\s,;]+/).filter(Boolean)

function toForm(row: any) {
  return {
    code: row.code || '', name: row.name || '', description: row.description || '',
    enabled: row.enabled !== false,
    starts_at: toLocalInput(row.starts_at), ends_at: toLocalInput(row.ends_at),
    per_user_limit: limitIn(row.per_user_limit), total_limit: limitIn(row.total_limit),
    allowed_user_ids: idsIn(row.allowed_user_ids),
    // 深拷贝：不然在表单里改一条条件会同时改掉列表里那一行，取消编辑也回不去。
    conditions: JSON.parse(JSON.stringify(row.conditions || [])),
    actions: JSON.parse(JSON.stringify(row.actions || []))
  }
}

/** 表单 → 完整的一张券（用于本地校验和 POST）。 */
function payload() {
  const f = form.value
  const ids = idsOut(f.allowed_user_ids)
  return {
    code: String(f.code || '').trim().toUpperCase(),
    name: String(f.name || '').trim(),
    description: String(f.description || '').trim(),
    enabled: f.enabled === true,
    starts_at: fromLocalInput(f.starts_at),
    ends_at: fromLocalInput(f.ends_at),
    per_user_limit: limitOut(f.per_user_limit),
    total_limit: limitOut(f.total_limit),
    allowed_user_ids: ids,
    conditions: f.conditions,
    actions: f.actions
  }
}

/**
 * 只发改动过的字段。
 *
 * 判等用 JSON.stringify 而不是逐字段比较：conditions / actions 是数组，而它们里面的键顺序由
 * blankCondition 和后端读回的那一行共同决定，是稳定的；键顺序真变了的话最坏后果是多发一个没改的
 * 字段，而不是漏发一个改过的。
 */
function diff(original: any) {
  const next: any = payload()
  const patch: any = {}
  for (const key of Object.keys(next)) {
    const before = original[key]
    if (key === 'starts_at' || key === 'ends_at') {
      if (!sameTime(before, next[key])) patch[key] = next[key]
      continue
    }
    if (key === 'allowed_user_ids' || key === 'conditions' || key === 'actions') {
      if (JSON.stringify(before ?? []) !== JSON.stringify(next[key] ?? [])) patch[key] = next[key]
      continue
    }
    // null 和 '' 在这里等价：后端把两者都当「不限」，而空输入框读出来是 ''。
    const a = before === null || before === undefined ? '' : before
    const b = next[key] === null || next[key] === undefined ? '' : next[key]
    if (a !== b) patch[key] = next[key]
  }
  return patch
}

/** allowed_user_ids 的空数组在库里是「不限」，但 validateCoupon 明确拒绝空数组（理由见它的注释）。
 *  这个翻译和 api/_routes/admin-coupons.mjs 的 forValidation 是同一件事，两边都只有这一行。 */
const forValidation = (c: any) => ({ ...c, allowed_user_ids: c.allowed_user_ids?.length ? c.allowed_user_ids : null })
const localCheck = computed(() => validateCoupon(forValidation(payload())))

/** 用过的券冻结券码、条件和动作：改了之后从券的定义倒推历史订单的折扣会得到另一个数字。 */
const usedCount = computed(() => Number(selected.value?.used_count || 0))
const frozen = computed(() => !isNew.value && usedCount.value > 0)
const canDelete = computed(() => auth.isAdmin.value && !isNew.value && usedCount.value === 0)
/** 顺序敏感，所以逐步算，用的是核销时的同一个 applyActions。 */
const preview = computed(() => applyActions(form.value.actions, previewAmount.value))
const money = (minor: any) => formatMinor(minor, previewCurrency.value)
const remainingText = (c: any) =>
  c.remaining === null || c.remaining === undefined ? '不限' : `剩 ${c.remaining}`

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

async function load() {
  loading.value = true
  try {
    rows.value = (await api('/api/admin-coupons')).coupons || []
    if (!rows.value.length) message.value = '还没有优惠券。点「新建」发第一张。'
  } catch (e: any) {
    rows.value = []
    message.value = e.message
  } finally {
    loading.value = false
  }
}

function choose(row: any) {
  selected.value = row
  isNew.value = false
  form.value = toForm(row)
  message.value = ''
}
function createCoupon() {
  selected.value = null
  isNew.value = true
  form.value = emptyForm()
  message.value = ''
}
function closeEditor() {
  selected.value = null
  isNew.value = false
  message.value = ''
}

function addCondition() { form.value.conditions.push(blankCondition('amount')) }
function addAction() { form.value.actions.push(blankAction('percent')) }
/** 换类型等于换一条新条件：不同类型的字段完全不同，留着上一种的键会被 validateCondition 判非法。 */
function retypeCondition(i: number, type: string) { form.value.conditions[i] = blankCondition(type) }
function retypeAction(i: number, type: string) { form.value.actions[i] = blankAction(type) }
function toggleStatus(c: any, status: string) {
  const list: string[] = c.statuses || (c.statuses = [])
  const at = list.indexOf(status)
  if (at >= 0) list.splice(at, 1)
  else list.push(status)
}
function toggleGroup(c: any, group: string) {
  const list: string[] = c.groups || (c.groups = [])
  const at = list.indexOf(group)
  if (at >= 0) list.splice(at, 1)
  else list.push(group)
}

async function save() {
  // 本地先过一遍 validateCoupon。这不是替代后端校验（后端一定会再校验一次），只是省一次往返。
  if (!localCheck.value.ok) { message.value = localCheck.value.error; return }
  saving.value = true
  try {
    if (isNew.value) {
      const { coupon } = await api('/api/admin-coupons', { method: 'POST', body: JSON.stringify(payload()) })
      message.value = `已创建 ${coupon.code}`
      await load()
      const fresh = rows.value.find(c => c.id === coupon.id)
      if (fresh) choose(fresh)
    } else {
      const patch = diff(selected.value)
      if (!Object.keys(patch).length) { message.value = '没有改动'; return }
      const { coupon } = await api('/api/admin-coupons', {
        method: 'PATCH', body: JSON.stringify({ id: selected.value.id, ...patch })
      })
      message.value = `已保存 ${coupon.code}（本次改了 ${Object.keys(patch).join('、')}）`
      await load()
      const fresh = rows.value.find(c => c.id === coupon.id)
      if (fresh) { selected.value = fresh; form.value = toForm(fresh) }
    }
  } catch (e: any) {
    message.value = e.message
  } finally {
    saving.value = false
  }
}

async function remove() {
  const row = selected.value
  if (!row) return
  if (!confirm(`删除 ${row.code}？这张券还没被使用过，删掉不会影响任何订单。要下架已经发出去的券请改为停用。`)) return
  try {
    await api('/api/admin-coupons', { method: 'DELETE', body: JSON.stringify({ id: row.id }) })
    message.value = `已删除 ${row.code}`
    closeEditor()
  } catch (e: any) {
    message.value = e.message
  }
  await load()
}

/** 停用不是删除：停用的券立刻用不了，核销记录还在。列表里的开关走的也是 PATCH。 */
async function toggleEnabled(row: any) {
  try {
    await api('/api/admin-coupons', { method: 'PATCH', body: JSON.stringify({ id: row.id, enabled: !row.enabled }) })
    message.value = row.enabled ? `${row.code} 已停用` : `${row.code} 已启用`
  } catch (e: any) {
    message.value = e.message
  }
  await load()
  if (selected.value?.id === row.id) {
    const fresh = rows.value.find(c => c.id === row.id)
    if (fresh) { selected.value = fresh; form.value = toForm(fresh) }
  }
}

watch(() => auth.ready.value, ready => { if (ready && auth.user.value) void load() }, { immediate: true })
</script>

<template>
<div class="coupon-pane">
<div class="admin-grid coupon-grid">
  <section class="records">
    <div class="section-toolbar">
      <div>
        <h2>{{ rows.length }} 张券</h2>
        <p>停用的券立刻用不了，记录还在；删除只对没用过的券开放。</p>
      </div>
      <button @click="createCoupon"><Plus :size="17" />新建</button>
    </div>
    <div v-if="loading" class="fluent-empty">加载中…</div>
    <article
      v-for="c in rows" :key="c.id"
      :class="{ selected: selected && selected.id === c.id }" @click="choose(c)">
      <div>
        <b>
          <code>{{ c.code }}</code>
          <em v-if="!c.enabled" class="coupon-off">已停用</em>
        </b>
        <small>
          {{ c.name || '未命名' }} · 已用 {{ c.used_count }} 次 · {{ remainingText(c) }}
          <template v-if="c.action_text?.length"> · {{ c.action_text.join('，') }}</template>
        </small>
      </div>
      <button :title="c.enabled ? '停用这张券' : '启用这张券'" @click.stop="toggleEnabled(c)">
        {{ c.enabled ? '停用' : '启用' }}
      </button>
    </article>
  </section>

  <section v-if="isNew || selected" class="record-editor coupon-editor">
    <div class="editor-title">
      <div>
        <p>{{ isNew ? 'NEW COUPON' : `COUPON / ${selected.code}` }}</p>
        <h2>{{ isNew ? '新建优惠券' : selected.name || selected.code }}</h2>
      </div>
      <button class="icon-button" title="关闭" @click="closeEditor"><X :size="18" /></button>
    </div>

    <p v-if="frozen" class="orders-hint">
      <CircleAlert :size="15" />这张券已被使用 {{ usedCount }} 次，券码、条件和动作不能再改：改了之后从券的定义倒推那几笔订单的折扣会得到另一个数字，而对账的人没有办法知道定义变过。要改请停用它并新建一张。
    </p>

    <form class="coupon-form" @submit.prevent="save">
      <div class="coupon-row">
        <label>券码
          <input v-model="form.code" required pattern="[0-9A-Za-z_-]{3,64}" :disabled="frozen" placeholder="SUMMER2026" />
          <small>3–64 位字母、数字、下划线或连字符。保存时统一转成大写——库里的唯一索引建在 upper(code) 上。</small>
        </label>
        <label>名称
          <input v-model="form.name" placeholder="夏季促销" />
          <small>只给后台看，用户输券码。</small>
        </label>
      </div>
      <label>说明
        <textarea v-model="form.description" rows="2" placeholder="这张券发给谁、为什么发。将来有人问「这券哪来的」时只有这里能回答。"></textarea>
      </label>
      <label class="check-label"><input v-model="form.enabled" type="checkbox" />启用（停用后用户立刻用不了，记录保留）</label>

      <div class="coupon-row">
        <label>生效时间<input v-model="form.starts_at" type="datetime-local" /><small>留空 = 立刻生效</small></label>
        <label>失效时间<input v-model="form.ends_at" type="datetime-local" /><small>留空 = 永不过期</small></label>
      </div>
      <div class="coupon-row">
        <label>每人限用
          <input v-model="form.per_user_limit" type="number" min="0" step="1" placeholder="不限" />
          <small>留空 = 不限，填 0 = 一次都不能用。这两者不同。</small>
        </label>
        <label>总量上限
          <input v-model="form.total_limit" type="number" min="0" step="1" placeholder="不限" />
          <small>
            余量由这个数和 used_count 比出来。
            <template v-if="!isNew"> 当前已用 {{ usedCount }} 次。</template>
            used_count 不能手改——改一次就是一次超发。
          </small>
        </label>
      </div>
      <label>限定用户（可选）
        <textarea v-model="form.allowed_user_ids" rows="2" placeholder="每行一个用户 uuid，可从「用户管理」复制；留空 = 所有人可用"></textarea>
        <small>留空是「不限」。注意不要理解成「填空数组等于不限」——那在求值上等于谁都不能用，所以后端会直接拒掉。</small>
      </label>

      <fieldset class="coupon-rules" :disabled="frozen">
        <legend>使用条件（全部满足才能用，没有「或」）</legend>
        <p v-if="!form.conditions.length" class="coupon-none">没有条件 = 任何订单都能用这张券。</p>
        <div v-for="(c, i) in form.conditions" :key="i" class="coupon-rule">
          <select :value="c.type" @change="retypeCondition(i, ($event.target as HTMLSelectElement).value)">
            <option v-for="t in CONDITION_TYPES" :key="t" :value="t">{{ CONDITION_LABEL[t] }}</option>
          </select>

          <template v-if="c.type === 'amount'">
            <select v-model="c.op"><option v-for="o in AMOUNT_OPERATORS" :key="o" :value="o">{{ OP_LABEL[o] }}</option></select>
            <input v-model.number="c.value" type="number" min="0" step="1" />
            <input v-model="c.currency" maxlength="3" placeholder="USD" class="coupon-cur" />
            <small>金额是最小货币单位（分 / cent）。币种必填：一张券挪到别的币种站点上会按错的数量级比较，而那不会报错，只会少收钱。</small>
          </template>

          <template v-else-if="c.type === 'sku'">
            <select v-model="c.op"><option v-for="o in SKU_OPERATORS" :key="o" :value="o">{{ SKU_OP_LABEL[o] }}</option></select>
            <input v-model="c.value" placeholder="aetherac-pro" />
          </template>

          <template v-else-if="c.type === 'order_history'">
            <select v-model="c.op"><option v-for="o in AMOUNT_OPERATORS" :key="o" :value="o">{{ OP_LABEL[o] }}</option></select>
            <input v-model.number="c.count" type="number" min="0" step="1" />
            <span class="coupon-checks">
              <label v-for="s in ORDER_STATUSES" :key="s">
                <input type="checkbox" :checked="c.statuses?.includes(s)" @change="toggleStatus(c, s)" />{{ ORDER_STATUS_LABEL[s] }}
              </label>
            </span>
            <small>选中的状态是求和，不是逐个比较：「已支付或已退款满 3 笔」是一个条件。</small>
          </template>

          <template v-else-if="c.type === 'first_order'">
            <select v-model="c.value">
              <option :value="true">仅限首次购买</option>
              <option :value="false">仅限已购买过的用户</option>
            </select>
            <small>首单按「付过钱」算，不按「下过单」算——否则一个下单没付、过期作废的用户就永远拿不到首单优惠。</small>
          </template>

          <template v-else>
            <span class="coupon-checks">
              <label v-for="g in GROUP_ORDER" :key="g">
                <input type="checkbox" :checked="c.groups?.includes(g)" @change="toggleGroup(c, g)" />{{ GROUP_LABEL[g] }}
              </label>
            </span>
          </template>

          <button type="button" class="coupon-drop" title="删掉这条条件" @click="form.conditions.splice(i, 1)"><X :size="15" /></button>
          <em>{{ describeCondition(c) }}</em>
        </div>
        <button type="button" class="coupon-add" @click="addCondition"><Plus :size="15" />添加条件</button>
      </fieldset>

      <fieldset class="coupon-rules" :disabled="frozen">
        <legend>优惠动作（按顺序执行）</legend>
        <div v-for="(a, i) in form.actions" :key="i" class="coupon-rule">
          <select :value="a.type" @change="retypeAction(i, ($event.target as HTMLSelectElement).value)">
            <option v-for="t in ACTION_TYPES" :key="t" :value="t">{{ ACTION_LABEL[t] }}</option>
          </select>
          <input v-model.number="a.value" type="number" step="1" :min="a.type === 'delta' ? undefined : 0" :max="a.type === 'percent' ? 10000 : undefined" />
          <small v-if="a.type === 'percent'">万分之，10000 = 原价，9000 = 打九折，0 = 全免。用整数是为了不在钱的计算路径上出现浮点数。</small>
          <small v-else-if="a.type === 'delta'">最小货币单位，可以是负数（减价）也可以是正数（加价，例如组合券里先加运费）。</small>
          <small v-else>最小货币单位的固定减免额。</small>
          <button type="button" class="coupon-drop" title="删掉这个动作" @click="form.actions.splice(i, 1)"><X :size="15" /></button>
          <em>{{ describeAction(a) }}</em>
        </div>
        <button type="button" class="coupon-add" @click="addAction"><Plus :size="15" />添加动作</button>
        <p class="coupon-none">顺序就是执行顺序：「先减 10 再打 9 折」和「先打 9 折再减 10」结果不同，这里不排序也不合并同类项。</p>
      </fieldset>

      <!-- 试算用的是核销时的同一个 applyActions，所以这里显示的每一步就是用户实际会被扣的数。 -->
      <div class="coupon-preview">
        <h3><BadgePercent :size="16" />折扣试算</h3>
        <div class="coupon-row">
          <label>订单金额（最小单位）<input v-model.number="previewAmount" type="number" min="0" step="1" /></label>
          <label>币种<input v-model="previewCurrency" maxlength="3" /></label>
        </div>
        <ol>
          <li v-for="(s, i) in preview.steps" :key="i">
            <b>{{ describeAction(s.action) }}</b><span>{{ money(s.before) }} → {{ money(s.after) }}</span>
          </li>
        </ol>
        <p>
          实付 <b>{{ money(preview.amountMinor) }}</b>，共减 <b>{{ money(preview.discountMinor) }}</b>。
          折扣额向下取整（零头归商家），所以小额订单上比例折扣可能被抹成 0。
        </p>
      </div>

      <p v-if="!localCheck.ok" class="orders-hint"><CircleAlert :size="15" />{{ localCheck.error }}</p>
      <div class="form-actions">
        <button class="fluent-primary" :disabled="saving || !localCheck.ok">
          <Save :size="17" />{{ saving ? '保存中…' : isNew ? '创建这张券' : '保存改动' }}
        </button>
        <button v-if="!isNew" type="button" class="fluent-secondary" @click="choose(selected)">放弃修改</button>
        <button v-if="canDelete" type="button" class="fluent-secondary coupon-del" @click="remove">
          <Trash2 :size="17" />删除
        </button>
      </div>
      <p v-if="!isNew && !canDelete && auth.isAdmin.value" class="coupon-none">
        已经被用过的券不提供删除：coupon_redemptions 是连带删除的，而那是「这笔订单为什么少收了钱」的唯一凭据。请改为停用。
      </p>
    </form>
  </section>
  <div v-else class="fluent-empty"><BadgePercent :size="28" /><h2>选择一张券，或新建一张</h2></div>
</div>
<p v-if="message" class="admin-message coupon-message">{{ message }}</p>
</div>
</template>
