<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ldcApi } from './ldc'
import { LDC_DEFAULTS } from '../../../shared/ldc.mjs'
const config = ref<any>({ ...LDC_DEFAULTS, offers: [] }), login = ref(false), ready = ref(false)
const configured = ref(false), busy = ref(false), message = ref('')
onMounted(async () => {
  try { const data = await ldcApi({}, '?view=admin'); config.value = data.config; login.value = data.linuxdo_enabled; configured.value = data.configured; ready.value = true }
  catch (e: any) { message.value = e.message }
})
function add() {
  config.value.offers.push({ id: `offer-${Date.now()}`, name: '', kind: 'coupon', enabled: false,
    ldc_minor: 10000, discount_minor: 500, currency: 'USD', sku: '', valid_days: 30 })
}
async function save() {
  busy.value = true; message.value = ''
  try { await ldcApi({ method: 'POST', body: JSON.stringify({ action: 'settings', config: config.value, linuxdo_enabled: login.value }) }); message.value = '已保存。规则实时生效；已发起的请求保留原权益快照。' }
  catch (e: any) { message.value = e.message }
  finally { busy.value = false }
}
</script>
<template>
  <section class="admin-ldc">
    <h2>Linux.DO 登录与 LDC</h2>
    <p>在 Supabase Auth 创建 <code>custom:linuxdo</code> OAuth Provider，启用 email_optional；UserInfo URL 使用本站 <code>/api/linuxdo-userinfo</code>，用于映射不可变用户 ID 并去除敏感字段。在 Linux.DO Connect 配置 Supabase 提供的回调地址。允许手动关联身份后，老用户可在账户页绑定，保留现有订单。</p>
    <p>LDC 密钥：{{ configured ? '服务端已配置' : '未配置 LDC_CLIENT_ID / LDC_CLIENT_SECRET（在环境变量页设置后重新部署）' }}</p>
    <form v-if="ready" @submit.prevent="save">
      <label><input v-model="login" type="checkbox">显示 Linux.DO 登录与绑定入口（须先完成 OAuth 配置）</label>
      <label><input v-model="config.enabled" type="checkbox">启用 LDC</label>
      <label><input v-model="config.discount_enabled" type="checkbox">启用 LDC 商品抵扣</label>
      <label><input v-model="config.coupon_enabled" type="checkbox">启用 LDC 换优惠券</label>
      <label><input v-model="config.support_enabled" type="checkbox">允许客服发起 LDC 扣款请求（用户确认后支付）</label>
      <label>客服单次上限（0.01 LDC）<input v-model.number="config.support_max_minor" type="number" min="1" max="100000000" required></label>
      <label>付款请求有效期（分钟）<input v-model.number="config.request_ttl_minutes" type="number" min="5" max="1440" required></label>
      <h3>兑换规则</h3><p>积分与优惠金额均使用最小单位：100 = 1.00。抵扣规则必须指定精确 SKU；普通兑换可留空，限定同币种商品。券限本人使用一次，不叠加；金额低于券面额时不可用。</p>
      <fieldset v-for="(offer, index) in config.offers" :key="index">
        <legend>规则 {{ index + 1 }}</legend>
        <label>规则 ID<input v-model="offer.id" pattern="[a-z0-9_-]{1,40}" required></label>
        <label>名称<input v-model="offer.name" maxlength="64" required></label>
        <label>用途<select v-model="offer.kind"><option value="discount">商品抵扣</option><option value="coupon">兑换优惠券</option></select></label>
        <label>LDC 数量（最小单位）<input v-model.number="offer.ldc_minor" type="number" min="1" max="100000000" required></label>
        <label>优惠金额（最小单位）<input v-model.number="offer.discount_minor" type="number" min="1" max="100000000" required></label>
        <label>币种<input v-model="offer.currency" pattern="[A-Z]{3}" maxlength="3" required></label>
        <label>精确 SKU<input v-model="offer.sku" maxlength="100" :required="offer.kind === 'discount'"></label>
        <label>到账后有效天数<input v-model.number="offer.valid_days" type="number" min="1" max="365" required></label>
        <label><input v-model="offer.enabled" type="checkbox">启用规则</label>
        <button class="fluent-secondary" type="button" @click="config.offers.splice(index, 1)">移除规则</button>
      </fieldset>
      <button class="fluent-secondary" type="button" :disabled="config.offers.length >= 50" @click="add">添加规则</button>
      <button class="fluent-primary" :disabled="busy">{{ busy ? '保存中…' : '保存配置' }}</button>
    </form>
    <p role="status">{{ message }}</p>
  </section>
</template>
<style scoped>
.admin-ldc{max-width:1000px}.admin-ldc p{line-height:1.7;color:#98b0a3}.admin-ldc form>label{display:flex;align-items:center;gap:10px;margin:14px 0}fieldset{border:1px solid var(--fluent-stroke, #35483d);border-radius:10px;margin:20px 0;padding:20px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}fieldset label{display:flex;flex-direction:column;gap:6px}input:not([type=checkbox]),select{border:1px solid var(--fluent-stroke, #35483d);border-radius:5px;padding:8px;color:#e0efe7;background:var(--fluent-layer, #151e1a)}button{margin:6px 10px 6px 0}@media(max-width:650px){fieldset{grid-template-columns:1fr}}
</style>
