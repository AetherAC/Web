// 在 Supabase Auth 里创建/更新 Linux.DO 的自定义 OAuth2 provider（custom:linuxdo）。
// 凭据从环境变量读，不写在文件里：
//   SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（或 secret key）、LINUXDO_CONNECT_CLIENT_ID、LINUXDO_CONNECT_CLIENT_SECRET
// 用法：node scripts/linuxdo-provider.mjs list|apply
// 轮换密钥时只需重新 apply 一次；identifier 与 provider_type 建好之后不可改。
import { createClient } from '@supabase/supabase-js'
import { LINUXDO_PROVIDER } from '../shared/ldc.mjs'

const mode = process.argv[2] || 'list'
if (!['list', 'apply'].includes(mode)) throw new Error('用法：node scripts/linuxdo-provider.mjs list|apply')

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin.customProviders
const site = new URL(process.env.SITE_URL || 'https://aetherac.abnt.it')
if (site.protocol !== 'https:') throw new Error('SITE_URL 必须是 HTTPS')

// userinfo 走本站的适配器，而不是直接指向 connect.linux.do/api/user：适配器把 Linux.DO 的数字 id 映射成
// OAuth 的 sub，并且拒掉未激活、被禁言的账号，同时不把 api_key、external_ids、邮箱转发进 Supabase 身份。
const desired = {
  provider_type: 'oauth2',
  identifier: LINUXDO_PROVIDER,
  name: 'Linux.DO',
  client_id: process.env.LINUXDO_CONNECT_CLIENT_ID,
  client_secret: process.env.LINUXDO_CONNECT_CLIENT_SECRET,
  authorization_url: 'https://connect.linux.do/oauth2/authorize',
  token_url: 'https://connect.linux.do/oauth2/token',
  userinfo_url: `${site.origin}/api/linuxdo-userinfo`,
  email_optional: true,
  pkce_enabled: true
}

const { data: listed, error: listError } = await admin.listProviders()
if (listError) throw new Error(`listProviders 失败：${listError.status || ''} ${listError.message}`)
const providers = listed?.providers || []
const existing = providers.find(p => p.identifier === desired.identifier)
console.log('现有 provider：', providers.map(p => `${p.identifier}(${p.provider_type})`).join(', ') || '（无）')

if (mode === 'list') {
  if (existing) console.log('custom:linuxdo：', JSON.stringify(existing, null, 2))
  process.exit(0)
}

if (!desired.client_id || !desired.client_secret) throw new Error('缺少 LINUXDO_CONNECT_CLIENT_ID / LINUXDO_CONNECT_CLIENT_SECRET')

if (existing) {
  // provider_type 和 identifier 不可变，其余字段整体重发一遍，保证与本文件声明一致。
  const { provider_type, identifier, ...patch } = desired
  const { data, error } = await admin.updateProvider(identifier, patch)
  if (error) throw new Error(`updateProvider 失败：${error.status || ''} ${error.code || ''} ${error.message}`)
  console.log('已更新：', JSON.stringify(data, null, 2))
} else {
  const { data, error } = await admin.createProvider(desired)
  if (error) throw new Error(`createProvider 失败：${error.status || ''} ${error.code || ''} ${error.message}`)
  console.log('已创建：', JSON.stringify(data, null, 2))
}

console.log(`\n要在 Linux.DO Connect 后台登记的回调地址：${new URL(url).origin}/auth/v1/callback`)
console.log(`站内登录入口：${new URL(url).origin}/auth/v1/authorize?provider=${encodeURIComponent(desired.identifier)}`)
