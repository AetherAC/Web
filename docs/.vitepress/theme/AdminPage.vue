<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { BarChart3, Boxes, CreditCard, FileText, GitBranch, KeyRound, LayoutDashboard, Plus, RefreshCw, Save, Settings, Trash2, Users } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import { supabase, useAuth } from './auth'
const auth = useAuth()
type Tab = 'overview'|'posts'|'progress_entries'|'repositories'|'artifacts'|'payment_providers'|'user_profiles'|'site_settings'|'environment'
const tab=ref<Tab>('overview'); const rows=ref<any[]>([]); const selected=ref<any>(null); const jsonDraft=ref(''); const message=ref(''); const stats=ref<any>(null)
const envs=ref<any[]>([]); const envForm=ref({id:'',key:'',value:'',sensitive:true}); const loading=ref(false)
const tabs=computed(()=>[
  {id:'overview',label:'概览',icon:LayoutDashboard},
  {id:'posts',label:'Blog / News',icon:FileText},
  {id:'progress_entries',label:'开发进度',icon:BarChart3},
  ...(auth.isAdmin.value?[
    {id:'repositories',label:'GitHub 仓库',icon:GitBranch},{id:'artifacts',label:'Artifact 与价格',icon:Boxes},
    {id:'payment_providers',label:'支付平台',icon:CreditCard},{id:'user_profiles',label:'用户组',icon:Users},
    {id:'site_settings',label:'网站设置',icon:Settings},{id:'environment',label:'环境变量',icon:KeyRound}
  ]:[])
] as Array<{id:Tab,label:string,icon:any}>)
const writable=computed(()=>auth.isAdmin.value || (auth.canEditContent.value && ['posts','progress_entries'].includes(tab.value)))
watch(()=>auth.ready.value,async ready=>{if(ready){if(!auth.user.value)auth.requireUser('/admin');else if(auth.group.value!=='default')await load()}},{immediate:true})
async function load(){
  selected.value=null; message.value=''
  if(tab.value==='overview'){ const r=await fetch('/api/installation-stats'); stats.value=await r.json(); return }
  if(tab.value==='environment'){ await loadEnv(); return }
  const {data,error}=await supabase!.from(tab.value).select('*').order('updated_at',{ascending:false})
  rows.value=data??[]; message.value=error?.message??''
}
function choose(row:any){selected.value={...row};jsonDraft.value=JSON.stringify(row,null,2)}
function createRecord(){
  const defaults:any={posts:{kind:'news',slug:'',title:'',summary:'',body:'',tags:[],status:'draft'},progress_entries:{stage:'00',title:'',summary:'',percent:0,status:'planned',sort_order:0},repositories:{name:'owner/repo',label:'',enabled:true},artifacts:{sku:'AETHER-STARTER',name:'',description:'',price_minor:0,currency:'USD',active:true,metadata:{}},payment_providers:{id:'custom',display_name:'',enabled:false,sort_order:100,public_config:{checkout_url_template:''},secret_env_names:['CUSTOM_WEBHOOK_SECRET'],instructions:''},site_settings:{key:'',value:{},description:''}}
  choose(defaults[tab.value]||{})
}
async function save(){
  try{const payload=JSON.parse(jsonDraft.value);const {error}=await supabase!.from(tab.value).upsert(payload);if(error)throw error;message.value='已保存';await load()}catch(e:any){message.value=e.message}
}
async function remove(row:any){if(!confirm('确认删除此记录？'))return;const pk=tab.value==='payment_providers'?'id':tab.value==='site_settings'?'key':tab.value==='user_profiles'?'user_id':'id';const {error}=await supabase!.from(tab.value).delete().eq(pk,row[pk]);message.value=error?.message??'已删除';await load()}
async function setGroup(row:any,event:Event){const group_name=(event.target as HTMLSelectElement).value;const {error}=await supabase!.from('user_profiles').update({group_name}).eq('user_id',row.user_id);message.value=error?.message??'用户组已更新';await load()}
async function api(path:string,options:any={}){const token=auth.session.value?.access_token;const r=await fetch(path,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...options.headers}});const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败');return data}
async function loadEnv(){loading.value=true;try{envs.value=(await api('/api/admin-env')).variables}catch(e:any){message.value=e.message}finally{loading.value=false}}
async function saveEnv(){try{const result=await api('/api/admin-env',{method:'PUT',body:JSON.stringify(envForm.value)});envForm.value={id:'',key:'',value:'',sensitive:true};message.value=result.redeployRequired?'环境变量已保存；请重新部署后生效。':'环境变量已保存，已触发重新部署。';await loadEnv()}catch(e:any){message.value=e.message}}
async function deleteEnv(v:any){if(!confirm(`删除 ${v.key}？`))return;await api('/api/admin-env',{method:'DELETE',body:JSON.stringify({id:v.id})});await loadEnv()}
async function selectTab(id:Tab){tab.value=id;await load()}
</script>
<template><div class="fluent-page admin-page"><SiteHeader/><main class="admin-shell"><aside class="admin-rail"><div class="admin-title"><span>A</span><div><b>Aether Admin</b><small>{{auth.user.value?.email}}</small></div></div><nav><button v-for="item in tabs" :key="item.id" :class="{active:tab===item.id}" @click="selectTab(item.id)"><component :is="item.icon" :size="19"/>{{item.label}}</button></nav><a href="/me">返回我的账户</a></aside><section class="admin-workspace">
<header class="workspace-head"><div><p>ADMIN CENTER / {{tab.toUpperCase()}}</p><h1>{{tabs.find(x=>x.id===tab)?.label}}</h1></div><button class="icon-button" @click="load"><RefreshCw :size="18"/></button></header>
<div v-if="auth.ready.value&&!auth.user.value" class="fluent-empty">正在跳转到登录页…</div><div v-else-if="auth.group.value==='default'" class="fluent-empty"><KeyRound :size="28"/><h2>您的用户组无权访问此页面</h2></div>
<template v-else-if="tab==='overview'"><div class="metric-grid"><article><span>累计装机量</span><strong>{{stats?.installed_hwid??'—'}}</strong><small>按 Sentry hwid 去重</small></article><article><span>当前运行量</span><strong>{{stats?.running_hwid??'—'}}</strong><small>{{stats?.configured?'Sentry 最近活动窗口':'尚未配置 Sentry'}}</small></article><article><span>当前权限</span><strong>{{auth.group.value}}</strong><small>由 Supabase RLS 强制执行</small></article></div><div class="admin-callout"><h3>装机统计配置</h3><p>在“环境变量”中设置 <code>SENTRY_ORG</code>、<code>SENTRY_PROJECT</code>、<code>SENTRY_AUTH_TOKEN</code>、<code>SENTRY_HWID_TAG</code>、<code>SENTRY_INSTALL_PERIOD</code> 和 <code>SENTRY_RUNNING_PERIOD</code>。客户端必须把稳定且匿名化后的标识作为 Sentry 自定义 tag 上报。</p></div></template>
<template v-else-if="tab==='environment'"><div class="env-layout"><section class="env-list"><div class="section-toolbar"><div><h2>Vercel 环境变量</h2><p>值不会返回浏览器；修改后需重新部署。</p></div></div><div v-if="loading">加载中…</div><article v-for="v in envs" :key="v.id"><KeyRound :size="18"/><div><b>{{v.key}}</b><small>{{v.target?.join(', ')}} · {{v.type}}</small></div><button @click="envForm={id:v.id,key:v.key,value:'',sensitive:v.type!=='plain'}">替换</button><button @click="deleteEnv(v)"><Trash2 :size="16"/></button></article></section><form class="record-editor" @submit.prevent="saveEnv"><h2>{{envForm.id?'替换变量':'添加变量'}}</h2><label>变量名<input v-model="envForm.key" required pattern="[A-Z][A-Z0-9_]*" placeholder="SENTRY_AUTH_TOKEN"></label><label>新值<textarea v-model="envForm.value" required rows="6" placeholder="值仅发送到 Vercel"></textarea></label><label class="check-label"><input v-model="envForm.sensitive" type="checkbox">敏感值（推荐）</label><button class="fluent-primary"><Save :size="17"/>保存到 Vercel</button><div class="admin-callout compact"><b>首次引导</b><p>必须先在 Vercel 控制台设置 <code>VERCEL_API_TOKEN</code>、<code>VERCEL_PROJECT_ID</code>，团队项目还需 <code>VERCEL_TEAM_ID</code>。</p></div></form></div></template>
<template v-else><div class="admin-grid"><section class="records"><div class="section-toolbar"><span>{{rows.length}} 条记录</span><button v-if="writable&&tab!=='user_profiles'" @click="createRecord"><Plus :size="17"/>新建</button></div><article v-for="row in rows" :key="row.id||row.user_id||row.key" :class="{selected:selected&&(selected.id===row.id||selected.user_id===row.user_id||selected.key===row.key)}" @click="choose(row)"><div><b>{{row.title||row.name||row.display_name||row.email||row.display_name||row.key||row.id}}</b><small>{{row.status||row.sku||row.name||row.group_name||row.description}}</small></div><select v-if="tab==='user_profiles'&&auth.isAdmin.value" :value="row.group_name" @click.stop @change="setGroup(row,$event)"><option v-for="g in ['default','read','coworker','admin']" :key="g">{{g}}</option></select><button v-else-if="writable" @click.stop="remove(row)"><Trash2 :size="16"/></button></article></section><section v-if="selected" class="record-editor"><div class="editor-title"><div><p>JSON RECORD</p><h2>记录编辑器</h2></div></div><textarea v-model="jsonDraft" rows="24" spellcheck="false" :readonly="!writable"></textarea><button v-if="writable" class="fluent-primary" @click="save"><Save :size="17"/>保存更改</button><div v-if="tab==='payment_providers'" class="admin-callout compact"><b>对接方式</b><p>在 <code>public_config.checkout_url_template</code> 配置结账地址模板；可用变量：<code>{order_id}</code>、<code>{sku}</code>、<code>{amount_minor}</code>、<code>{currency}</code>、<code>{callback_url}</code>。在环境变量页填写该平台列出的 <code>secret_env_names</code>。回调地址统一为 <code>/v1/callback/&lt;provider&gt;</code>。</p></div></section><div v-else class="fluent-empty">选择一条记录查看详情。</div></div></template><p class="admin-message">{{message}}</p></section></main></div></template>
