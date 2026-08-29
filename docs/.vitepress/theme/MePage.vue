<script setup lang="ts">
import { ref, watch } from 'vue'
import { ArrowUpRight, CreditCard, LogOut, Package, ReceiptText, UserRound, XCircle } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue';import SiteFooter from './SiteFooter.vue';import {supabase,useAuth} from './auth'
const auth=useAuth();const orders=ref<any[]>([]);const cancelling=ref('');const message=ref('')
async function load(){const {data}=await supabase!.from('orders').select('*').order('created_at',{ascending:false});orders.value=data??[]}
watch(()=>auth.ready.value,async ready=>{if(!ready)return;if(!auth.user.value){auth.requireUser('/me');return}await load()},{immediate:true})
const total=()=>orders.value.filter(x=>x.status==='paid').reduce((n,x)=>n+x.amount_minor,0)
const money=(n:number,c='USD')=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:c}).format(n/100)
// The warning about an open payment page is not boilerplate: cancelling is one-way here, but a payment
// that actually goes through afterwards still marks the order paid. Better to say so than to let a
// buyer pay for an order they believe they cancelled.
async function cancel(order:any){
  if(!auth.session.value)return
  if(!confirm(`取消订单 ${order.sku}（${money(order.amount_minor,order.currency)}）？\n\n如果支付页面还开着，请先关掉：取消后若仍完成付款，订单会重新变为已支付。`))return
  cancelling.value=order.id;message.value=''
  try{
    const r=await fetch('/api/cancel-order',{method:'POST',headers:{Authorization:`Bearer ${auth.session.value.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({order_id:order.id})})
    const data=await r.json()
    message.value=r.ok?'订单已取消，现在可以重新下单。':data.error
    await load()
  }catch(e:any){message.value=e.message}
  finally{cancelling.value=''}
}
</script>
<template><div class="fluent-page"><SiteHeader/><main class="account-main"><section class="account-head"><div class="account-avatar"><UserRound/></div><div><p>我的账户</p><h1>{{auth.user.value?.user_metadata?.display_name||auth.user.value?.email}}</h1><span>{{auth.group.value}} · {{auth.user.value?.email_confirmed_at?'邮箱已验证':'邮箱未验证'}}</span></div><button @click="auth.signOut"><LogOut :size="17"/>退出</button></section><section class="account-metrics"><article><CreditCard/><span>累计消费</span><strong>{{money(total(),orders[0]?.currency||'USD')}}</strong></article><article><ReceiptText/><span>订单数量</span><strong>{{orders.length}}</strong></article><article><Package/><span>已完成购买</span><strong>{{orders.filter(x=>x.status==='paid').length}}</strong></article></section><section class="order-history"><header><div><p>ORDER HISTORY</p><h2>购买记录</h2></div><a href="/buy">购买 Artifact <ArrowUpRight :size="16"/></a></header><p v-if="message" class="order-message">{{message}}</p><div class="order-table"><div v-for="o in orders" :key="o.id" class="order-row"><a :href="`/order/${o.id}`"><span><b>{{o.sku}}</b><small>{{new Date(o.created_at).toLocaleString('zh-CN')}}</small></span><span>{{o.provider}}</span><span>{{money(o.amount_minor,o.currency)}}</span><em :class="`order-${o.status}`">{{o.status}}</em><ArrowUpRight :size="16"/></a><button v-if="o.status==='pending'" class="cancel-order" :disabled="cancelling===o.id" @click="cancel(o)"><XCircle :size="15"/>{{cancelling===o.id?'取消中…':'取消订单'}}</button></div><div v-if="!orders.length" class="fluent-empty">还没有订单。</div></div><small v-if="orders.some(o=>o.status==='pending')" class="pending-note">每个账户同时只能有 1 笔待支付订单。要买别的构建，请先完成或取消上面那笔。</small></section></main><SiteFooter/></div></template>
