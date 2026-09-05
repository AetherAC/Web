<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ArrowRight, Check, PackageOpen, ShieldCheck } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'
import LdcPanel from './LdcPanel.vue'
import { supabase, useAuth } from './auth'
import { orderPath } from './routes'
import { preloadMarkdown, renderMarkdown } from './markdown'
const auth = useAuth()
const products = ref<any[]>([]), providers = ref<any[]>([]), selectedProvider = ref('')
const busy = ref(''), message = ref(''), pendingOrder = ref<any>(null), couponCode = ref('')
const quotes = ref<Record<string, any>>({})
watch(() => auth.ready.value, ready => { if (ready && !auth.user.value) auth.requireUser('/buy') }, { immediate: true })
watch(couponCode, () => { quotes.value = {} })
onMounted(async () => {
  void preloadMarkdown()
  couponCode.value = new URLSearchParams(location.search).get('coupon') || ''
  if (!supabase) return
  const [{ data: p }, { data: ways }] = await Promise.all([
    supabase.from('artifacts').select('*').eq('active', true).order('price_minor'),
    supabase.from('payment_providers').select('id,display_name,public_config').eq('enabled', true).order('sort_order')
  ])
  products.value = p ?? []; providers.value = ways ?? []; selectedProvider.value = providers.value[0]?.id ?? ''
})
const money = (p: any) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: p.currency }).format(p.price_minor / 100)
async function request(path: string, body: any) {
  const r = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${auth.session.value?.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json()
  if (!r.ok) { pendingOrder.value = data.pending_order ?? null; throw new Error(data.error) }
  return data
}
async function preview(product: any) {
  const code = couponCode.value.trim().toUpperCase()
  busy.value = product.id; message.value = ''
  try {
    const quote = await request('/api/coupon', { artifact_id: product.id, code })
    if (code !== couponCode.value.trim().toUpperCase()) return
    if (!quote.ok) throw new Error(quote.error)
    quotes.value = { ...quotes.value, [product.id]: quote }
  } catch (e: any) { message.value = e.message }
  finally { busy.value = '' }
}
async function buy(product: any) {
  if (!auth.session.value || busy.value) return
  const code = couponCode.value.trim().toUpperCase()
  if (code && !quotes.value[product.id]?.ok) { await preview(product); return }
  busy.value = product.id; message.value = ''; pendingOrder.value = null
  try {
    const data = await request('/api/checkout', { artifact_id: product.id, provider: selectedProvider.value, coupon_code: code })
    location.href = data.order.checkout_url || orderPath(data.order.id)
  } catch (e: any) { message.value = e.message }
  finally { busy.value = '' }
}
</script>
<template>
  <div class="fluent-page"><SiteHeader/><main class="commerce-main">
    <section class="commerce-hero"><p class="eyebrow">AETHERAC ARTIFACTS</p><h1>选择适合你网络规模的构建。</h1><p>价格和 SKU 由管理员实时配置。每次购买都会生成归属于当前账户的订单。</p></section>
    <section class="payment-choice"><label for="payment-method">支付方式</label><select id="payment-method" v-model="selectedProvider"><option v-for="p in providers" :key="p.id" :value="p.id">{{p.display_name}}</option></select><small v-if="!providers.length">当前没有启用的支付平台</small></section>
    <section class="payment-choice"><label for="coupon-code">优惠券 / LDC 抵扣券</label><input id="coupon-code" v-model="couponCode" maxlength="32" placeholder="输入券码，先预览实付金额"><small>每单限一张；下单时服务端重新校验。</small></section>
    <section class="product-grid">
      <article v-for="(p,index) in products" :key="p.id" :class="{featured:index===1}">
        <div class="product-icon"><PackageOpen/></div><span>{{p.sku}}</span><h2>{{p.name}}</h2><div class="product-desc markdown-body" v-html="renderMarkdown(p.description)"></div>
        <strong>{{ quotes[p.id]?.ok ? quotes[p.id].amount_text : money(p) }}</strong>
        <p v-if="quotes[p.id]?.ok">原价 {{ money(p) }} · 已减 {{ quotes[p.id].discount_text }}</p>
        <ul><li v-for="feature in (p.metadata?.features||['绑定 AetherAC 账户','订单与退款记录','安全支付回调'])" :key="feature"><Check :size="16"/>{{feature}}</li></ul>
        <button :disabled="Boolean(busy) || (!selectedProvider && !couponCode && p.price_minor !== 0)" @click="buy(p)">{{busy===p.id?'正在处理…':couponCode && !quotes[p.id]?.ok?'预览优惠金额':'确认购买'}}<ArrowRight :size="17"/></button>
      </article>
      <div v-if="!products.length" class="fluent-empty"><ShieldCheck/><h2>商品正在准备中</h2><p>管理员可在 /admin 配置 Artifact SKU、价格与币种。</p></div>
    </section>
    <p class="form-message" role="status">{{message}}</p><p v-if="pendingOrder" class="form-message"><a class="fluent-primary" :href="orderPath(pendingOrder.id)">前往待支付订单 {{pendingOrder.sku}} <ArrowRight :size="16"/></a></p>
    <LdcPanel @coupon="couponCode = $event"/>
  </main><SiteFooter/></div>
</template>
<style scoped>
.payment-choice input{border:1px solid var(--fluent-stroke);border-radius:6px;padding:10px;background:var(--fluent-card);color:inherit;min-width:0;max-width:100%}
</style>
