// Declarative column metadata for the /admin record editor. Every editable column gets a real
// input; only genuinely free-form jsonb columns stay JSON. Kept out of the SFC so the value
// conversions can be exercised by tests/api-smoke.mjs.
export type Field={key:string,label:string,type:'text'|'textarea'|'number'|'boolean'|'select'|'tags'|'json'|'datetime',options?:string[],hint?:string,required?:boolean,placeholder?:string,pattern?:string,wide?:boolean,min?:number,max?:number,rows?:number,pk?:boolean,nullable?:boolean}

export const SCHEMA:Record<string,Field[]>={
  posts:[
    {key:'kind',label:'类型',type:'select',options:['news','blog'],required:true,hint:'news 出现在 /news 新闻列表，blog 出现在 /blog 博客列表'},
    {key:'status',label:'状态',type:'select',options:['draft','published'],required:true,hint:'draft 草稿只有 read / coworker / admin 能看到；改成 published 才对所有访客公开'},
    {key:'title',label:'标题',type:'text',required:true,wide:true,hint:'列表卡片和文章顶部显示的大标题'},
    {key:'slug',label:'URL 短名',type:'text',required:true,pattern:'[a-z0-9]+(-[a-z0-9]+)*',placeholder:'release-0-1-0',hint:'决定文章地址 /news/<短名>；只能用小写字母、数字和连字符，发布后改动会让旧链接失效'},
    {key:'cover_url',label:'封面图地址',type:'text',nullable:true,placeholder:'https://…',hint:'列表卡片和文章头图用的完整 http(s) 地址；留空则不显示图片'},
    {key:'tags',label:'标签',type:'tags',placeholder:'anticheat, release',hint:'用逗号分隔，例如 anticheat, release；显示在标题下方'},
    {key:'published_at',label:'发布时间',type:'datetime',hint:'列表按这个时间倒序排列；留空则使用保存时的当前时间'},
    {key:'featured',label:'设为置顶推荐',type:'boolean',hint:'勾选后这篇排在列表最前面，首页也会优先展示'},
    {key:'summary',label:'摘要',type:'textarea',rows:3,required:true,wide:true,hint:'列表页显示的一两句话，不会进入正文'},
    {key:'body',label:'正文（Markdown）',type:'textarea',rows:18,required:true,wide:true,hint:'支持 Markdown：## 小标题、**粗体**、`代码`、- 列表、[文字](链接)'}
  ],
  progress_entries:[
    {key:'stage',label:'阶段编号',type:'text',required:true,placeholder:'00',hint:'显示在标题前的短标识，例如 00、01、02'},
    {key:'status',label:'状态',type:'select',options:['planned','active','complete','paused'],required:true,hint:'planned 计划中 / active 进行中 / complete 已完成 / paused 已暂停，进度页用不同颜色区分'},
    {key:'title',label:'标题',type:'text',required:true,wide:true,hint:'这个阶段在开发进度页显示的名字'},
    {key:'percent',label:'完成度（%）',type:'number',min:0,max:100,required:true,hint:'0 到 100 的整数，进度条按它渲染'},
    {key:'sort_order',label:'排序权重',type:'number',hint:'数字小的排在前面；相同时按更新时间'},
    {key:'summary',label:'说明（Markdown）',type:'textarea',rows:5,required:true,wide:true,hint:'这个阶段具体在做什么，进度页会完整显示；支持 Markdown 与换行。首页 mini 卡片只渲染行内格式（粗体 / 代码 / 链接），标题和列表在那里保持字面'}
  ],
  repositories:[
    {key:'name',label:'仓库',type:'text',required:true,pattern:'[^/]+/[^/]+',placeholder:'AetherAC/AetherAC',hint:'GitHub 的 owner/repo 格式，用来抓取提交数并显示在进度页'},
    {key:'label',label:'显示名称',type:'text',hint:'进度页上代替仓库名显示的中文名；留空则直接显示 owner/repo'},
    {key:'enabled',label:'在进度页展示',type:'boolean',hint:'取消勾选后该仓库对访客隐藏，也不再抓取提交（read 以上的账号仍能看到）'}
  ],
  artifacts:[
    {key:'sku',label:'SKU',type:'text',required:true,placeholder:'AETHER-STARTER',hint:'商品唯一编号，下单时写入订单，之后不建议再改'},
    {key:'name',label:'名称',type:'text',required:true,hint:'购买页和订单记录里显示的商品名'},
    {key:'price_minor',label:'价格（最小货币单位）',type:'number',min:0,required:true,hint:'以分为单位填写整数：1999 表示 19.99'},
    {key:'currency',label:'货币',type:'text',required:true,pattern:'[A-Z]{3}',placeholder:'USD',hint:'三位大写 ISO 代码，例如 USD、CNY、EUR'},
    {key:'active',label:'上架销售',type:'boolean',hint:'取消勾选后商品从购买页下架，已产生的订单不受影响'},
    {key:'description',label:'描述（Markdown）',type:'textarea',rows:6,wide:true,hint:'购买页显示在商品名下方；支持 Markdown：**粗体**、`代码`、- 列表、[文字](链接)，直接换行就会换行'},
    {key:'metadata',label:'附加元数据',type:'json',rows:5,wide:true,hint:'数据库里是自由结构的 jsonb，给后续功能留的扩展位；用不到就保留 {}'}
  ],
  payment_providers:[
    {key:'id',label:'平台 ID',type:'text',required:true,pk:true,placeholder:'alipay',hint:'主键，同时决定回调地址 /v1/callback/<id>；建议只用小写字母'},
    {key:'display_name',label:'显示名称',type:'text',required:true,hint:'结账页按钮上显示的名字，例如“支付宝”'},
    {key:'sort_order',label:'排序权重',type:'number',hint:'数字小的排在结账页前面'},
    {key:'enabled',label:'启用该支付平台',type:'boolean',hint:'取消勾选后结账页不再显示这个支付方式，回调地址仍然保留'},
    {key:'secret_env_names',label:'需要的密钥变量名',type:'tags',wide:true,hint:'逗号分隔的变量名，例如 ALIPAY_APP_ID, ALIPAY_PRIVATE_KEY；这里只登记名字，真实值到“环境变量”页填写，不会存进数据库'},
    {key:'public_config',label:'公开配置',type:'json',rows:8,wide:true,hint:'可以公开的参数（jsonb）。"driver":"stripe" / "paypal" / "payerurl" / "alipay" 会改用站内内置的对接代码，其余键都被忽略；PayPal 另有 "environment":"sandbox"|"live"，支付宝另有 "environment":"sandbox" 和 "product":"page"|"wap"（不填按买家设备自动选）。支付宝只结算人民币，非人民币订单按汇率折算后收款：默认取欧洲央行每日参考汇率，"fx_rates":{"USD":7.15} 可以钉死某个币种的汇率（填了就不再联网），"fx_markup":0.02 在汇率上加 2% 点差（默认不加）。不填 driver 时走通用模式：checkout_url_template 支持变量 {order_id} {sku} {amount_minor} {currency} {callback_url}'},
    {key:'instructions',label:'接入说明',type:'textarea',rows:6,wide:true,hint:'只给后台看的操作步骤备注，访客看不到'}
  ],
  site_settings:[
    {key:'key',label:'设置键',type:'text',required:true,pk:true,placeholder:'checkout_notice',hint:'主键，代码里按这个键取值'},
    {key:'description',label:'说明',type:'text',wide:true,hint:'给后台看的备注：这个键是干什么用的、谁在读它'},
    {key:'value',label:'值',type:'json',rows:10,wide:true,hint:'jsonb，可以是对象 {"a":1}、数组 [1,2]、字符串 "文字"、数字或 true / false。注意：目前站点代码还没有读取任何键，这张表是留给后续功能的'}
  ]
}

export function defaultRecord(table:string):any{
  if(table==='posts')return {kind:'news',slug:'',title:'',summary:'',body:'',cover_url:null,tags:[],status:'draft',featured:false,published_at:new Date().toISOString()}
  if(table==='progress_entries')return {stage:'00',title:'',summary:'',percent:0,status:'planned',sort_order:0}
  if(table==='repositories')return {name:'',label:'',enabled:true}
  if(table==='artifacts')return {sku:'',name:'',description:'',price_minor:0,currency:'USD',active:true,metadata:{}}
  if(table==='payment_providers')return {id:'',display_name:'',enabled:false,sort_order:100,public_config:{checkout_url_template:''},secret_env_names:[],instructions:''}
  if(table==='site_settings')return {key:'',value:{},description:''}
  return {}
}

const pad=(n:number)=>String(n).padStart(2,'0')
// timestamptz -> the local "YYYY-MM-DDTHH:mm" that <input type="datetime-local"> requires.
export const toLocalInput=(iso:any)=>{const d=new Date(iso);return iso&&!isNaN(+d)?`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`:''}

// DB row -> input-friendly draft: arrays become comma text, jsonb becomes pretty JSON.
export function toForm(fields:Field[],row:any):any{
  const out:any={...row}
  for(const f of fields){
    const v=row?.[f.key]
    if(f.type==='tags')out[f.key]=Array.isArray(v)?v.join(', '):String(v??'')
    else if(f.type==='json')out[f.key]=v===undefined||v===null?'{}':JSON.stringify(v,null,2)
    else if(f.type==='datetime')out[f.key]=toLocalInput(v)
    else if(f.type==='boolean')out[f.key]=Boolean(v)
    else if(f.type==='number')out[f.key]=typeof v==='number'?v:Number(v??0)
    else out[f.key]=v??''
  }
  return out
}

// Draft -> the shapes Postgres expects. Columns with no field (id, created_at) pass through so
// upsert updates the existing row instead of inserting a duplicate.
export function fromForm(fields:Field[],draft:any):any{
  const out:any={...draft}
  for(const f of fields){
    const v=draft?.[f.key]
    if(f.type==='tags')out[f.key]=String(v??'').split(',').map((s)=>s.trim()).filter(Boolean)
    else if(f.type==='json'){try{out[f.key]=JSON.parse(String(v??'').trim()||'{}')}catch{throw new Error(`“${f.label}”不是合法的 JSON`)}}
    else if(f.type==='datetime'){const s=String(v??'').trim();if(s)out[f.key]=new Date(s).toISOString();else delete out[f.key]}
    else if(f.type==='number')out[f.key]=Number(v)
    else if(f.type==='boolean')out[f.key]=Boolean(v)
    else if(f.nullable&&!String(v??'').trim())out[f.key]=null
  }
  return out
}

export function rowMeta(table:string,row:any):string{
  if(table==='posts')return [row.kind,row.status,row.slug].filter(Boolean).join(' · ')
  if(table==='progress_entries')return `阶段 ${row.stage} · ${row.status} · ${row.percent}%`
  if(table==='repositories')return `${row.name}${row.enabled?'':' · 已停用'}`
  if(table==='artifacts')return `${row.sku} · ${(Number(row.price_minor)/100).toFixed(2)} ${row.currency}${row.active?'':' · 已下架'}`
  if(table==='payment_providers')return `${row.id} · ${row.enabled?'已启用':'未启用'}`
  if(table==='site_settings')return row.description||'无说明'
  return ''
}

export function fieldHint(f:Field,draft:any,isNew:boolean):string|undefined{
  if(f.pk&&!isNew)return [f.hint,'主键不可修改；要换 ID 请新建一条记录再删除旧的'].filter(Boolean).join(' · ')
  if(f.key==='price_minor'){const n=Number(draft?.price_minor);if(Number.isFinite(n))return `${f.hint} · 当前 = ${(n/100).toFixed(2)} ${draft?.currency??''}`.trim()}
  return f.hint
}
