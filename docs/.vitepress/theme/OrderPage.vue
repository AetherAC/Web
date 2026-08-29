<script setup lang="ts">
import { ref, watch } from 'vue'
import { ArrowLeft, ExternalLink, ImagePlus, RotateCcw, ShieldAlert, XCircle } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'
import { supabase, useAuth } from './auth'
const auth=useAuth(); const order=ref<any>(null); const refund=ref<any>(null); const denied=ref(false)
const reason=ref('duplicate'); const detail=ref(''); const files=ref<File[]>([]); const message=ref(''); const sending=ref(false)
const cancelling=ref(false); const cancelMessage=ref('')
const orderId=()=>location.pathname.split('/').filter(Boolean)[1]||new URLSearchParams(location.search).get('order_id')
const justPaid=()=>typeof window!=='undefined'&&new URLSearchParams(location.search).get('paid')==='1'
async function fetchOrder(strict=false){
  const {data,error}=await supabase!.from('orders').select('*').eq('id',orderId()).maybeSingle()
  if(error||!data){if(strict)denied.value=true;return null}
  order.value=data
  return data
}
watch(()=>auth.ready.value,async ready=>{
  if(!ready)return
  if(!auth.user.value){auth.requireUser(typeof window==='undefined'?'/order':location.pathname);return}
  const data=await fetchOrder(true)
  if(!data)return
  // Stripe and PayPal send the buyer back here before their callback has necessarily landed, so an
  // order that was just paid can still read `pending` for a few seconds. Poll instead of showing
  // this buyer a "继续付款" button for money they have already handed over.
  if(justPaid()&&data.status==='pending'){
    for(let attempt=0;attempt<6;attempt++){
      await new Promise(resolve=>setTimeout(resolve,2000))
      const next=await fetchOrder()
      if(next&&next.status!=='pending')break
    }
  }
  const {data:r}=await supabase!.from('refund_requests').select('*').eq('order_id',data.id).maybeSingle()
  refund.value=r
},{immediate:true})
const money=(n:number,c='USD')=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:c}).format(n/100)
async function cancelOrder(){
  if(!order.value||!auth.session.value)return
  // Same warning as /me: cancelling is one-way, but a payment that still lands afterwards wins.
  if(!confirm(`取消订单 ${order.value.sku}（${money(order.value.amount_minor,order.value.currency)}）？\n\n如果支付页面还开着，请先关掉：取消后若仍完成付款，订单会重新变为已支付。`))return
  cancelling.value=true;cancelMessage.value=''
  try{
    const r=await fetch('/api/cancel-order',{method:'POST',headers:{Authorization:`Bearer ${auth.session.value.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({order_id:order.value.id})})
    const data=await r.json()
    cancelMessage.value=r.ok?'订单已取消，现在可以重新下单。':data.error
    await fetchOrder()
  }catch(e:any){cancelMessage.value=e.message}
  finally{cancelling.value=false}
}
async function submitRefund(){
  if(!order.value||!auth.user.value)return
  sending.value=true
  const paths:string[]=[]
  for(const file of files.value){
    const path=`${auth.user.value.id}/${order.value.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`
    const {error}=await supabase!.storage.from('refund-evidence').upload(path,file)
    if(error){message.value=error.message;sending.value=false;return}
    paths.push(path)
  }
  const {data,error}=await supabase!.from('refund_requests').insert({
    order_id:order.value.id,user_id:auth.user.value.id,reason_code:reason.value,
    reason_detail:detail.value,evidence_paths:paths
  }).select().single()
  message.value=error?.message??'退款申请已提交'
  refund.value=data??null
  sending.value=false
}
</script>
<template><div class="fluent-page"><SiteHeader/><main class="order-main"><a class="back-link" href="/me"><ArrowLeft :size="17"/>返回订单列表</a><div v-if="denied" class="fluent-empty denied"><ShieldAlert/><h1>无权访问此订单</h1><p>订单不存在，或不属于当前账户。</p></div><template v-else-if="order"><section class="order-summary"><div><p>ORDER / {{order.id}}</p><h1>{{order.sku}}</h1><span :class="`order-${order.status}`">{{order.status}}</span></div><strong>{{new Intl.NumberFormat('zh-CN',{style:'currency',currency:order.currency}).format(order.amount_minor/100)}}</strong></section><section class="order-detail-grid"><article><h2>订单信息</h2><dl><div><dt>支付平台</dt><dd>{{order.provider}}</dd></div><div><dt>创建时间</dt><dd>{{new Date(order.created_at).toLocaleString('zh-CN')}}</dd></div><div><dt>平台订单号</dt><dd>{{order.provider_order_id||'等待支付'}}</dd></div></dl><div v-if="order.status==='pending'" class="order-actions"><a v-if="order.checkout_url" class="fluent-primary" :href="order.checkout_url">继续付款<ExternalLink :size="16"/></a><button class="cancel-order" :disabled="cancelling" @click="cancelOrder"><XCircle :size="15"/>{{cancelling?'取消中…':'取消订单'}}</button></div><p v-if="cancelMessage" class="order-message">{{cancelMessage}}</p><small v-if="order.status==='pending'" class="pending-note">每个账户同时只能有 1 笔待支付订单。取消这笔后即可购买其他构建。</small></article><article class="refund-card"><template v-if="refund"><RotateCcw/><h2>退款申请</h2><strong>{{refund.status}}</strong><p>{{refund.reason_detail}}</p><small>提交于 {{new Date(refund.created_at).toLocaleString('zh-CN')}}</small></template><form v-else-if="order.status==='paid'" @submit.prevent="submitRefund"><h2>申请退款</h2><label>退款理由<select v-model="reason"><option value="duplicate">重复购买</option><option value="not_as_described">与描述不符</option><option value="technical_issue">技术问题</option><option value="other">其他</option></select></label><label>详细说明<textarea v-model="detail" required minlength="10" rows="5" placeholder="请描述退款原因"></textarea></label><label class="upload-field"><ImagePlus/><span>上传图片证据（JPG / PNG / WebP，单张 5MB）</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple @change="files=Array.from(($event.target as HTMLInputElement).files||[])"></label><small>{{files.length}} 个文件</small><button class="fluent-primary" :disabled="sending">{{sending?'正在提交…':'提交退款申请'}}</button><p>{{message}}</p></form><div v-else><h2>退款</h2><p>订单支付完成后可从此处提交退款申请。</p></div></article></section></template><div v-else class="fluent-empty">正在加载订单…</div></main><SiteFooter/></div></template>
