<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Ban, BadgePercent, BarChart3, Boxes, CreditCard, FileText, Gavel, Github, GitBranch, KeyRound, LayoutDashboard, Plus, ReceiptText, RefreshCw, Save, Settings, ShieldCheck, Trash2, UserX, Users, Zap } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import AdminOrders from './AdminOrders.vue'
import AdminRefunds from './AdminRefunds.vue'
import AdminCoupons from './AdminCoupons.vue'
import AdminAutoReplies from './AdminAutoReplies.vue'
import { GROUP_LABEL, GROUP_ORDER, supabase, useAuth } from './auth'
import { SCHEMA, defaultRecord, fieldHint as hintFor, fromForm, rowMeta as metaFor, toForm, type Field } from './recordForm'
const auth = useAuth()
type Tab = 'overview'|'posts'|'progress_entries'|'orders'|'refunds'|'coupons'|'auto_replies'|'repositories'|'artifacts'|'payment_providers'|'user_profiles'|'site_settings'|'environment'
const tab=ref<Tab>('overview'); const rows=ref<any[]>([]); const selected=ref<any>(null); const message=ref(''); const stats=ref<any>(null)
const envs=ref<any[]>([]); const envForm=ref({id:'',key:'',value:'',sensitive:true}); const loading=ref(false)
const userStats=ref({admins:0}); const cascade=ref(false)
// 订单和优惠券那两页自己管数据。这个 key 只在点右上角刷新时 +1，用来把组件整个重挂——它们内部有筛选
// 条件和打开的编辑器，与其从外面伸手去调它们的 load()，不如让 Vue 重建一次。
const childKey=ref(0)
// Keyed by the field names summarise() returns, so a new breakdown on the server shows up here by
// adding one line — the labels are the only part that has to be written twice.
const breakdowns=[{key:'by_mcver',label:'Minecraft 版本'},{key:'by_loader',label:'加载器'},{key:'by_licensestatus',label:'许可证状态'},{key:'by_osarch',label:'系统架构'}]
const form=ref<any>({}); const raw=ref(''); const isNew=ref(false)
const tabs=computed(()=>[
  {id:'overview',label:'概览',icon:LayoutDashboard},
  {id:'posts',label:'Blog / News',icon:FileText},
  {id:'progress_entries',label:'开发进度',icon:BarChart3},
  // §12.2：rank ≥ 111（read 及以上）就看得到全部订单，所以这一条不在 isAdmin 的分支里。改状态的门槛
  // 由服务端的 can_modify 决定，不由这里决定——藏掉整个页面等于让售后连订单都查不了。
  ...(auth.canViewOrders.value?[{id:'orders',label:'订单管理',icon:ReceiptText}]:[]),
  // §1.1：发券是管理员和客服都有的权限（删券只有管理员，那一条在接口里判）。
  ...(auth.isStaff.value?[
    // §10.6：门槛和 api/_routes/admin-refunds.mjs 一样是 STAFF——售后要能看板子上有什么、发起了什么，
    // 但批准和执行只有 admin 能点。谁能点由服务端的 can_decide 和每行的 actions 决定，不由这里决定：
    // 客服看到一块灰掉的按钮，比看到一个空页面更能说明「这一步要找管理员」。
    {id:'refunds',label:'退款审批',icon:Gavel},
    {id:'coupons',label:'优惠券',icon:BadgePercent},
    // §3：改规则只有 admin，但客服要能看——用户会话开头收到的那句话是哪条规则发的，只有这里说得清。
    {id:'auto_replies',label:'自动回复',icon:Zap}
  ]:[]),
  ...(auth.isAdmin.value?[
    {id:'repositories',label:'GitHub 仓库',icon:GitBranch},{id:'artifacts',label:'Artifact 与价格',icon:Boxes},
    {id:'payment_providers',label:'支付平台',icon:CreditCard},{id:'user_profiles',label:'用户管理',icon:Users},
    {id:'site_settings',label:'网站设置',icon:Settings},{id:'environment',label:'环境变量',icon:KeyRound}
  ]:[])
] as Array<{id:Tab,label:string,icon:any}>)
const writable=computed(()=>auth.isAdmin.value || (auth.canEditContent.value && ['posts','progress_entries'].includes(tab.value)))
const fields=computed<Field[]>(()=>SCHEMA[tab.value]??[])
watch(()=>auth.ready.value,async ready=>{if(ready){if(!auth.user.value)auth.requireUser('/admin');else if(auth.group.value!=='default')await load()}},{immediate:true})
async function load(){
  selected.value=null; message.value=''
  // Authenticated now: the response carries per-version breakdowns of individual installs, so the
  // endpoint checks for admin and an unauthenticated fetch would come back 401.
  if(tab.value==='overview'){ try{stats.value=await api('/api/installation-stats')}catch(e:any){stats.value=null;message.value=e.message} return }
  if(tab.value==='environment'){ await loadEnv(); return }
  if(tab.value==='orders'||tab.value==='refunds'||tab.value==='coupons'||tab.value==='auto_replies'){ childKey.value++; return }
  if(tab.value==='user_profiles'){ await loadUsers(); return }
  const {data,error}=await supabase!.from(tab.value).select('*').order('updated_at',{ascending:false})
  rows.value=data??[]; message.value=error?.message??''
}
function choose(row:any){selected.value={...row};isNew.value=false;form.value=toForm(fields.value,row);raw.value=JSON.stringify(row,null,2)}
function createRecord(){choose(defaultRecord(tab.value));isNew.value=true}
function applyRaw(){try{form.value=toForm(fields.value,JSON.parse(raw.value));message.value='已把 JSON 填回表单，仍需点击保存'}catch(e:any){message.value=`JSON 解析失败：${e.message}`}}
const rowMeta=(row:any)=>metaFor(tab.value,row)
const fieldHint=(f:Field)=>hintFor(f,form.value,isNew.value)
async function save(){
  try{const payload=fromForm(fields.value,form.value);const {error}=await supabase!.from(tab.value).upsert(payload);if(error)throw error;message.value=isNew.value?'已创建':'已保存';await load()}catch(e:any){message.value=e.message}
}
async function remove(row:any){if(!confirm('确认删除此记录？'))return;const pk=tab.value==='payment_providers'?'id':tab.value==='site_settings'?'key':'id';const {error}=await supabase!.from(tab.value).delete().eq(pk,row[pk]);message.value=error?.message??'已删除';await load()}
async function loadUsers(){loading.value=true;try{const data=await api('/api/admin-users');rows.value=data.users;userStats.value={admins:data.admins}}catch(e:any){rows.value=[];message.value=e.message}finally{loading.value=false}}
// §6：按 GitHub 团队重算权限组。单个用户走 login，全量走 all:true（服务端串行打 GitHub，慢但不撞速率限制）。
async function syncGroups(row?:any){
  const label=row?`${row.email||row.user_id}`:'全部 GitHub 账号'
  if(row&&!row.github_login){message.value=`${label} 不是 GitHub 登录的账号，没有可同步的团队`;return}
  if(!row&&!confirm('按 GitHub 团队重算所有账号的权限组？手动改过的组会被团队映射覆盖。'))return
  loading.value=true;message.value=`正在同步 ${label}…`
  try{
    const data=await api('/api/sync-github-groups',{method:'POST',body:JSON.stringify(row?{login:row.github_login,user_id:row.user_id}:{all:true})})
    if(data.configured===false){message.value=data.message;return}
    if(row)message.value=data.synced?`${label} → ${data.group_name}（命中团队：${data.teams?.join('、')||'无，按组织成员给 read'}）`:`${label} 未改动：${data.skipped}`
    else{const failed=(data.results||[]).filter((r:any)=>r.error).length
      message.value=`扫描 ${data.scanned} 个 GitHub 账号，更新 ${data.changed} 个${failed?`，${failed} 个失败`:''}`}
  }catch(e:any){message.value=e.message}finally{loading.value=false;await loadUsers()}
}
async function setGroup(row:any,event:Event){const group_name=(event.target as HTMLSelectElement).value;try{await api('/api/admin-users',{method:'PATCH',body:JSON.stringify({user_id:row.user_id,group_name})});if(selected.value?.user_id===row.user_id)selected.value.group_name=group_name;message.value=`${row.email||row.user_id} 已设为 ${group_name}`}catch(e:any){message.value=e.message}await loadUsers()}
async function toggleBan(row:any){const action=row.banned?'unban':'ban';if(action==='ban'&&!confirm(`封禁 ${row.email||row.user_id}？该账号将无法登录，但数据保留。`))return;try{await api('/api/admin-users',{method:'POST',body:JSON.stringify({user_id:row.user_id,action})});if(selected.value?.user_id===row.user_id)selected.value.banned=action==='ban';message.value=action==='ban'?'账号已封禁':'账号已解封'}catch(e:any){message.value=e.message}await loadUsers()}
async function deleteUser(row:any){
  if(!confirm(`永久删除 ${row.email||row.user_id}？此操作不可撤销。`))return
  try{const {deleted}=await api('/api/admin-users',{method:'DELETE',body:JSON.stringify({user_id:row.user_id,cascade:cascade.value})})
    message.value=`账号已删除；同时清理 ${deleted.orders} 条订单、${deleted.refunds} 条退款、${deleted.files} 个凭证文件`
    selected.value=null;cascade.value=false}catch(e:any){message.value=e.message}
  await loadUsers()
}
async function api(path:string,options:any={}){const token=auth.session.value?.access_token;const r=await fetch(path,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...options.headers}});const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败');return data}
async function loadEnv(){loading.value=true;try{envs.value=(await api('/api/admin-env')).variables}catch(e:any){message.value=e.message}finally{loading.value=false}}
async function saveEnv(){try{const result=await api('/api/admin-env',{method:'PUT',body:JSON.stringify(envForm.value)});envForm.value={id:'',key:'',value:'',sensitive:true};message.value=result.redeployRequired?'环境变量已保存；请重新部署后生效。':'环境变量已保存，已触发重新部署。';await loadEnv()}catch(e:any){message.value=e.message}}
async function deleteEnv(v:any){if(!confirm(`删除 ${v.key}？`))return;await api('/api/admin-env',{method:'DELETE',body:JSON.stringify({id:v.id})});await loadEnv()}
// 从订单管理页「到退款审批看板处理这笔」跳过来时带的订单号。只在这一次跳转里有效：手动点侧栏的
// 「退款审批」走的是 selectTab(id) 的默认参数，会把它清空——否则上次看过的那笔订单会一直挂在筛选
// 条件上，而这块看板默认该显示的是所有在途申请。
const refundOrderId=ref('')
const openRefunds=(orderId:string)=>selectTab('refunds',orderId)
// load() 会把 childKey +1 把子组件整个重挂，所以 order-id 必须在那之前赋好值，不能指望同一个 tick 里
// 的批量更新替我们排序。
async function selectTab(id:Tab,orderId=''){refundOrderId.value=id==='refunds'?orderId:'';tab.value=id;await load()}
</script>
<template><div class="fluent-page admin-page"><SiteHeader/><main class="admin-shell"><aside class="admin-rail"><div class="admin-title"><span>A</span><div><b>Aether Admin</b><small>{{auth.user.value?.email}}</small></div></div><nav><button v-for="item in tabs" :key="item.id" :class="{active:tab===item.id}" @click="selectTab(item.id)"><component :is="item.icon" :size="19"/>{{item.label}}</button></nav><a href="/me">返回我的账户</a></aside><section class="admin-workspace">
<header class="workspace-head"><div><p>ADMIN CENTER / {{tab.toUpperCase()}}</p><h1>{{tabs.find(x=>x.id===tab)?.label}}</h1></div><button class="icon-button" @click="load"><RefreshCw :size="18"/></button></header>
<div v-if="auth.ready.value&&!auth.user.value" class="fluent-empty">正在跳转到登录页…</div><div v-else-if="auth.group.value==='default'" class="fluent-empty"><KeyRound :size="28"/><h2>您的用户组无权访问此页面</h2></div>
<template v-else-if="tab==='overview'"><div class="metric-grid"><article><span>累计装机量</span><strong>{{stats?.installed_hwid??'—'}}</strong><small>按 hwid 去重，每个装机一行</small></article><article><span>当前运行量</span><strong>{{stats?.running_hwid??'—'}}</strong><small>{{stats?.configured?`最近 ${stats.running_window_minutes} 分钟内上报过`:'尚未配置 TELEMETRY_INGEST_KEY，无法接收上报'}}</small></article><article><span>当前权限</span><strong>{{auth.group.value}}</strong><small>由 Supabase RLS 强制执行</small></article></div><div class="metric-grid"><article><span>累计错误</span><strong>{{stats?.errors??'—'}}</strong><small>详细堆栈在 Sentry</small></article><article><span>累计崩溃</span><strong>{{stats?.crashes??'—'}}</strong><small>致命异常，含启动失败</small></article><article><span>累计警告</span><strong>{{stats?.warns??'—'}}</strong><small>日志中的 WARN 计数</small></article></div><div v-if="stats?.installed_hwid" class="telemetry-breakdown"><section v-for="group in breakdowns" :key="group.key"><h3>{{group.label}}</h3><p v-if="!Object.keys(stats[group.key]||{}).length" class="breakdown-empty">窗口内没有运行中的装机</p><ul v-else><li v-for="(count,value) in stats[group.key]" :key="value"><b>{{value}}</b><i><em :style="{width:`${count/stats.running_hwid*100}%`}"/></i><span>{{count}}</span></li></ul></section></div><div class="admin-callout"><h3>这些数字从哪来</h3><p>装机量与运行量来自装机自身向 <code>/api/telemetry</code> 上报的心跳，落在 <code>telemetry_installs</code> 表里，一个 hwid 一行；上报需要在“环境变量”中设置 <code>TELEMETRY_INGEST_KEY</code>，未设置时端点会直接拒收而不是匿名接受。<code>hwid</code> 是对稳定机器特征做加盐 SHA-256 后的结果，不是可还原的机器标识。<br>错误、崩溃与日志正文走 Sentry，插件用 DSN 直接投递，这里只显示计数。计数不从 Sentry 反查：Sentry 的 errors 数据集只装得下出过错的装机，用它统计装机量会把干净运行的服务器整个漏掉；而把心跳也发成 Sentry 事件，按 5 分钟一次算单台每月约 8,640 条，一台就能打满免费额度。</p></div></template>
<template v-else-if="tab==='orders'"><AdminOrders :key="childKey" @open-refunds="openRefunds"/></template>
<template v-else-if="tab==='refunds'"><AdminRefunds :key="childKey" :order-id="refundOrderId"/></template>
<template v-else-if="tab==='coupons'"><AdminCoupons :key="childKey"/></template>
<template v-else-if="tab==='auto_replies'"><AdminAutoReplies :key="childKey"/></template>
<template v-else-if="tab==='environment'"><div class="env-layout"><section class="env-list"><div class="section-toolbar"><div><h2>Vercel 环境变量</h2><p>值不会返回浏览器；修改后需重新部署。</p></div></div><div v-if="loading">加载中…</div><article v-for="v in envs" :key="v.id"><KeyRound :size="18"/><div><b>{{v.key}}</b><small>{{v.target?.join(', ')}} · {{v.type}}</small></div><button @click="envForm={id:v.id,key:v.key,value:'',sensitive:v.type!=='plain'}">替换</button><button @click="deleteEnv(v)"><Trash2 :size="16"/></button></article></section><form class="record-editor env-form" @submit.prevent="saveEnv"><h2>{{envForm.id?'替换变量':'添加变量'}}</h2><label>变量名<input v-model="envForm.key" required pattern="[A-Z][A-Z0-9_]*" placeholder="SENTRY_AUTH_TOKEN"><small>只能用大写字母、数字和下划线，必须以字母开头。填一个已存在的名字等于覆盖它的值。</small></label><label>新值<textarea v-model="envForm.value" required rows="6" placeholder="值仅发送到 Vercel"></textarea><small>整段粘贴，前后空格会被 Vercel 保留。值只发往 Vercel，不写入数据库也不会再回显到这个页面。</small></label><label class="check-label"><input v-model="envForm.sensitive" type="checkbox">敏感值（推荐）</label><small class="env-note">勾选后这个值在 Vercel 控制台和 <code>vercel env pull</code> 里都不再可读，只有函数运行时能取到；密钥、令牌、数据库密码都应该勾。</small><button class="fluent-primary"><Save :size="17"/>保存到 Vercel</button><div class="admin-callout compact"><b>首次引导</b><p>必须先在 Vercel 控制台设置 <code>VERCEL_API_TOKEN</code>、<code>VERCEL_PROJECT_ID</code>，团队项目还需 <code>VERCEL_TEAM_ID</code>。</p></div></form></div></template>
<template v-else-if="tab==='user_profiles'"><div class="fluent-notice compact"><b>七个用户组分别能做什么</b><p><code>default</code> 普通买家，只能看公开内容和自己的订单，进不了这个后台。<code>read</code> 能额外看到草稿文章、已停用的仓库，以及<b>全部订单</b>（只读）——加入组织本身就是获得这个可见性的方式。<code>coworker</code> 文案，在 <code>read</code> 之上可以增删改 Blog / News 和开发进度。<code>presale</code> / <code>postsale</code> 售前 / 售后客服，能接工单、看订单与退款；售后可以发起退款申请，但批准只有 <code>admin</code> 能做。<code>cs</code> 同时属于售前和售后团队的人，工单分配优先级高于单一客服。<code>admin</code> 拥有全部权限，包括支付平台、环境变量和这个页面。</p><p>编辑权限<b>不</b>按客服优先级递增：<code>presale</code> 在工单分配上高于 <code>coworker</code>，但不能发文章——这两件事是两条独立的判断。全部权限由 Supabase RLS 在数据库层强制，不是靠前端藏按钮。</p></div><div class="admin-grid"><section class="records"><div class="section-toolbar"><span>{{rows.length}} 个账号 · {{userStats.admins}} 名管理员</span><span class="toolbar-actions"><button :disabled="loading" @click="syncGroups()"><Github :size="17"/>按 GitHub 团队同步</button><button @click="loadUsers"><RefreshCw :size="17"/>刷新</button></span></div><div v-if="loading" class="fluent-empty">加载中…</div><article v-for="row in rows" :key="row.user_id" :class="{selected:selected&&selected.user_id===row.user_id}" @click="choose(row)"><div><b>{{row.email||row.display_name||row.user_id}}</b><small>{{GROUP_LABEL[row.group_name]||row.group_name}}<template v-if="row.github_login"> · @{{row.github_login}}</template><template v-if="row.orders"> · {{row.orders}} 单</template><template v-if="row.banned"> · 已封禁</template><template v-if="row.profile_missing"> · 无 profile 行</template><template v-if="row.self"> · 当前登录</template></small></div><select :value="row.group_name" @click.stop @change="setGroup(row,$event)"><option v-for="g in GROUP_ORDER" :key="g" :value="g">{{GROUP_LABEL[g]}}（{{g}}）</option></select><button v-if="row.github_login" title="按 GitHub 团队重算此账号的用户组" @click.stop="syncGroups(row)"><Github :size="16"/></button><button :title="row.banned?'解除封禁':'封禁账号'" @click.stop="toggleBan(row)"><component :is="row.banned?ShieldCheck:Ban" :size="16"/></button><button title="删除账号" @click.stop="deleteUser(row)"><UserX :size="16"/></button></article></section>
<section v-if="selected" class="record-editor"><div class="editor-title"><div><p>USER / {{selected.user_id}}</p><h2>{{selected.email||selected.display_name||'未命名账号'}}</h2></div></div><div class="metric-grid"><article><span>用户组</span><strong>{{GROUP_LABEL[selected.group_name]||selected.group_name}}</strong><small>{{selected.profile_missing?'profile 行缺失，改组时自动补建':`${selected.group_name} · 由 Supabase RLS 强制执行`}}</small></article><article><span>订单 / 退款</span><strong>{{selected.orders}} / {{selected.refunds}}</strong><small>两者均为 on delete restrict</small></article><article><span>账号状态</span><strong>{{selected.banned?'已封禁':'正常'}}</strong><small>{{selected.email_confirmed?'邮箱已验证':'邮箱未验证'}}</small></article></div><div class="admin-callout compact"><b>登录信息</b><p>登录方式：{{selected.providers?.length?selected.providers.join('、'):'—'}}<br>注册时间：{{selected.created_at}}<br>最后登录：{{selected.last_sign_in_at||'从未登录'}}<br>GitHub：{{selected.github_login?`@${selected.github_login}`:'未关联'}}<template v-if="selected.github_synced_at"><br>上次团队同步：{{selected.github_synced_at}}</template></p></div><div class="editor-row"><button class="fluent-secondary" @click="toggleBan(selected)"><component :is="selected.banned?ShieldCheck:Ban" :size="17"/>{{selected.banned?'解除封禁':'封禁账号'}}</button><button v-if="selected.github_login" class="fluent-secondary" @click="syncGroups(selected)"><Github :size="17"/>按 GitHub 团队同步</button></div><label class="check-label"><input v-model="cascade" type="checkbox">连带删除该账号的订单与退款记录（不可恢复）</label><button class="fluent-primary" @click="deleteUser(selected)"><UserX :size="17"/>永久删除此账号</button><div class="admin-callout compact"><b>删不掉的时候</b><p>唯一的管理员账号、以及当前登录的账号会被服务端拒绝，避免把自己锁在后台之外。存在交易记录的账号需要先勾选连带删除。</p></div></section><div v-else class="fluent-empty"><Users :size="28"/><h2>选择一个账号查看详情</h2></div></div></template>
<template v-else><div class="admin-grid"><section class="records"><div class="section-toolbar"><span>{{rows.length}} 条记录</span><button v-if="writable" @click="createRecord"><Plus :size="17"/>新建</button></div><article v-for="row in rows" :key="row.id||row.key" :class="{selected:selected&&(selected.id===row.id||selected.key===row.key)}" @click="choose(row)"><div><b>{{row.title||row.display_name||row.name||row.key||row.id}}</b><small>{{rowMeta(row)}}</small></div><button v-if="writable" @click.stop="remove(row)"><Trash2 :size="16"/></button></article></section><section v-if="selected" class="record-editor"><div class="editor-title"><div><p>{{isNew?'NEW RECORD':'EDIT RECORD'}}</p><h2>{{isNew?'新建记录':'编辑记录'}}</h2></div></div>
<form class="field-form" @submit.prevent="save"><label v-for="f in fields" :key="f.key" :class="[f.type==='boolean'?'check-field':'',f.wide?'wide':'']">
<template v-if="f.type==='boolean'"><span class="check-row"><input v-model="form[f.key]" type="checkbox" :disabled="!writable">{{f.label}}</span><small v-if="fieldHint(f)">{{fieldHint(f)}}</small></template>
<template v-else><span>{{f.label}}<b v-if="f.required"> *</b></span>
<select v-if="f.type==='select'" v-model="form[f.key]" :disabled="!writable"><option v-for="o in f.options" :key="o" :value="o">{{o}}</option></select>
<textarea v-else-if="f.type==='textarea'||f.type==='json'" v-model="form[f.key]" :class="{mono:f.type==='json'}" :rows="f.rows||4" :required="f.required" spellcheck="false" :readonly="!writable"></textarea>
<input v-else-if="f.type==='number'" v-model.number="form[f.key]" type="number" :min="f.min" :max="f.max" :required="f.required" :readonly="!writable">
<input v-else-if="f.type==='datetime'" v-model="form[f.key]" type="datetime-local" :readonly="!writable">
<input v-else v-model="form[f.key]" type="text" :placeholder="f.placeholder" :pattern="f.pattern" :required="f.required" :readonly="!writable||(f.pk&&!isNew)">
<small v-if="fieldHint(f)">{{fieldHint(f)}}</small></template></label>
<div v-if="writable" class="form-actions"><button class="fluent-primary"><Save :size="17"/>{{isNew?'创建记录':'保存更改'}}</button><button type="button" class="fluent-secondary" @click="isNew?createRecord():choose(selected)">放弃修改</button></div>
<details class="raw-json"><summary>原始 JSON（可选，需要整段粘贴时才用）</summary><textarea v-model="raw" rows="14" spellcheck="false"></textarea><button v-if="writable" type="button" class="fluent-secondary" @click="applyRaw">填回表单</button></details></form>
<div v-if="tab==='payment_providers'" class="admin-callout compact"><b>对接方式</b><p>回调地址统一为 <code>/v1/callback/&lt;平台 ID&gt;</code>。“需要的密钥变量名”只登记名字，实际值到“环境变量”页填写，不会存进数据库。</p></div></section><div v-else class="fluent-empty">选择一条记录查看详情。</div></div></template><p class="admin-message">{{message}}</p></section></main></div></template>
