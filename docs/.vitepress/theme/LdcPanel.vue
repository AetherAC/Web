<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useAuth } from './auth'
import { ldcApi, linuxdoLogin, submitLdcPayment } from './ldc'
import { LINUXDO_PROVIDER } from '../../../shared/ldc.mjs'
import { formatMinor } from '../../../shared/coupons.mjs'

const props = defineProps<{ sessionId?: string; staff?: boolean; canRequest?: boolean }>()
const emit = defineEmits<{ coupon: [code: string] }>()
const auth = useAuth()
const config = ref<any>(null), orders = ref<any[]>([]), busy = ref(false), message = ref('')
const amount = ref(''), reason = ref(''), confirmation = ref<any>(null)
const linked = computed(() => auth.user.value?.identities?.some(i => i.provider === LINUXDO_PROVIDER))
const mine = (o: any) => o.user_id === auth.user.value?.id
const amountText = (n: number) => (n / 100).toFixed(2)
const expired = (o: any) => Date.parse(o.expires_at) <= Date.now()
const labels: Record<string, string> = { pending: '待确认', declined: '已拒绝', paid: '已完成' }
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
async function load() {
  const current = ++generation
  clearTimeout(timer)
  if (!auth.user.value) return
  try {
    const cfg = await ldcApi({}, '?view=config')
    if (current !== generation) return
    config.value = cfg
    const data = await ldcApi({}, props.sessionId ? `?session_id=${encodeURIComponent(props.sessionId)}` : '')
    if (current !== generation) return
    orders.value = data.orders
  } catch (e: any) { if (current === generation) message.value = e.message }
  finally {
    if (current === generation && (props.sessionId || orders.value.some(o => o.status === 'pending'))) timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void load()
      else timer = setTimeout(() => void load(), 15000)
    }, 15000)
  }
}
watch(() => [auth.user.value?.id, props.sessionId], () => {
  confirmation.value = null; orders.value = []; message.value = ''
  if (auth.ready.value) void load()
}, { immediate: true })
watch(() => auth.ready.value, ready => { if (ready) void load() })
onScopeDispose(() => { generation++; clearTimeout(timer) })

async function run(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; message.value = ''
  try { await work() } catch (e: any) { message.value = e.message }
  finally { busy.value = false }
}
async function create(offerId?: string) {
  await run(async () => {
    const data = await ldcApi({ method: 'POST', body: JSON.stringify({ action: 'create',
      ...(offerId ? { offer_id: offerId } : { session_id: props.sessionId, amount: amount.value, name: reason.value }) }) })
    if (offerId) confirmation.value = data.order
    else { reason.value = ''; amount.value = ''; message.value = '已发起请求，等待用户确认；尚未扣除任何 LDC。' }
    await load()
  })
}
async function pay() {
  const order = confirmation.value
  if (!order) return
  await run(async () => {
    const payment = await ldcApi({ method: 'POST', body: JSON.stringify({ action: 'pay', id: order.id, confirm: true }) })
    submitLdcPayment(payment)
  })
}
async function action(order: any, action: string) {
  await run(async () => {
    const data = await ldcApi({ method: 'POST', body: JSON.stringify({ action, id: order.id }) })
    message.value = action === 'sync' ? (data.order.status === 'paid' ? 'LDC 已到账，权益已发放。' : 'LDC 平台尚未确认付款，请稍后重试。') : '请求已拒绝。'
    await load()
  })
}
</script>

<template>
  <section v-if="auth.user.value && (config?.enabled || config?.linuxdo_enabled || orders.length || message)" class="ldc-panel">
    <header><div><p class="eyebrow">LINUX.DO CREDIT</p><h2>{{ sessionId ? 'LDC 服务请求' : 'LDC 权益与优惠券' }}</h2></div><button type="button" class="fluent-secondary" :disabled="busy" @click="load">刷新</button></header>
    <p v-if="!sessionId">使用 LDC 获取本人专用优惠券；商品抵扣先兑换券，再在结算时使用。每张券限用一次，不与其他券叠加。</p>
    <button v-if="!sessionId && config?.linuxdo_enabled && !linked" class="fluent-secondary" :disabled="busy" @click="run(async () => { await linuxdoLogin(true) })">绑定 Linux.DO，保留当前账户和订单</button>
    <p v-else-if="!sessionId && linked">已绑定 Linux.DO</p>
    <div v-if="!sessionId && config?.enabled" class="ldc-offers">
      <article v-for="offer in config.offers" :key="offer.id">
        <small>{{ offer.kind === 'discount' ? '商品抵扣' : '兑换优惠券' }} · {{ offer.sku || '同币种商品' }}</small>
        <h3>{{ offer.name }}</h3>
        <strong>{{ amountText(offer.ldc_minor) }} LDC</strong>
        <p>减免 {{ formatMinor(offer.discount_minor, offer.currency) }} · 到账后 {{ offer.valid_days }} 天有效</p>
        <button class="fluent-primary" :disabled="busy" @click="create(offer.id)">查看并确认兑换</button>
      </article>
      <p v-if="!config.offers?.length">暂无可兑换权益。</p>
    </div>
    <form v-if="sessionId && staff && canRequest && config?.enabled && config?.support_enabled" class="ldc-request" @submit.prevent="create()">
      <label>请求扣除 LDC<input v-model="amount" type="number" min="0.01" step="0.01" :max="config.support_max_minor / 100" required></label>
      <label>用途说明<input v-model="reason" maxlength="64" required placeholder="说明本次服务与收费内容"></label>
      <button class="fluent-primary" :disabled="busy">向用户发起确认请求</button>
      <small>客服不能直接扣款。用户需确认金额和用途，并在 LDC 平台授权。</small>
    </form>
    <div v-if="confirmation" class="ldc-confirm" role="region" aria-label="LDC 付款确认">
      <h3>确认使用 {{ amountText(confirmation.ldc_minor) }} LDC？</h3>
      <p>{{ confirmation.name }}</p>
      <p v-if="confirmation.benefit?.discount_minor">获得 {{ formatMinor(confirmation.benefit.discount_minor, confirmation.benefit.currency) }} 优惠券，仅当前账户可用。</p>
      <p>下一步前往 credit.linux.do。仅在平台确认成功后扣除积分；关闭页面不代表已撤销授权。</p>
      <button class="fluent-primary" :disabled="busy" @click="pay">确认金额，前往 LDC 授权</button>
      <button class="fluent-secondary" :disabled="busy" @click="confirmation = null">暂不支付</button>
    </div>
    <div v-for="order in orders" :key="order.id" class="ldc-order">
      <div><b>{{ order.name }}</b><span>{{ amountText(order.ldc_minor) }} LDC · {{ order.status === 'pending' && expired(order) ? '已过期（已付款可同步）' : labels[order.status] }}</span><small>{{ new Date(order.created_at).toLocaleString('zh-CN') }}</small></div>
      <template v-if="mine(order)">
        <button v-if="order.status === 'pending' && !expired(order) && config?.enabled" class="fluent-secondary" :disabled="busy" @click="confirmation = order">确认付款</button>
        <button v-if="order.status === 'pending' && !order.consented_at" class="fluent-secondary" :disabled="busy" @click="action(order, 'decline')">拒绝</button>
        <button v-if="order.status === 'pending' && order.consented_at" class="fluent-secondary" :disabled="busy" @click="action(order, 'sync')">我已付款，同步状态</button>
        <a v-if="order.coupon_code" class="fluent-secondary" :href="`/buy?coupon=${encodeURIComponent(order.coupon_code)}`" @click="emit('coupon', order.coupon_code)">使用券 {{ order.coupon_code }}</a>
      </template>
    </div>
    <p v-if="message" role="status" class="form-message">{{ message }}</p>
  </section>
</template>

<style scoped>
.ldc-panel{margin:24px 0;padding:24px;border:1px solid var(--fluent-stroke, #35483d);border-radius:16px;background:var(--fluent-card, #101714);color:#e0efe7}
header{display:flex;align-items:center;justify-content:space-between;gap:16px}h2{margin:4px 0 12px;font-size:22px}.ldc-panel p{line-height:1.6}.ldc-offers{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:20px 0}.ldc-offers article,.ldc-confirm{padding:18px;border:1px solid var(--fluent-stroke, #35483d);border-radius:12px}.ldc-confirm{border-color:#b98a2d;background:#241f12;margin:16px 0}.ldc-panel strong{font-size:24px}.ldc-panel small{display:block;color:#98b0a3}.ldc-request{display:grid;gap:12px;margin:16px 0}.ldc-request label{display:grid;gap:6px}.ldc-request input{width:100%;border:1px solid var(--fluent-stroke, #35483d);border-radius:6px;padding:8px;background:var(--fluent-layer, #151e1a);color:#e0efe7}.ldc-order{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:16px 0;border-top:1px solid var(--fluent-stroke, #35483d);overflow-wrap:anywhere}.ldc-order>div{flex:1;min-width:180px}.ldc-order span{display:block;font-size:13px}.ldc-panel button,.ldc-panel a{margin:3px 0}@media(max-width:600px){.ldc-panel{padding:14px}.ldc-offers{grid-template-columns:1fr}}
</style>
