<script setup lang="ts">
import { ref } from 'vue'
import { Github, LockKeyhole, Mail, ShieldCheck, ArrowRight, BadgeCheck } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import { authRedirect, supabase, useAuth } from './auth'
const props = defineProps<{ mode: 'login' | 'register' }>()
const { configured } = useAuth()
const email = ref(''); const password = ref(''); const displayName = ref(''); const otp = ref('')
const step = ref<'form' | 'verify'>('form'); const busy = ref(false); const message = ref('')
async function submit() {
  if (!supabase) return
  busy.value = true; message.value = ''
  if (props.mode === 'register') {
    const { data, error } = await supabase.auth.signUp({ email: email.value, password: password.value, options: { data: { display_name: displayName.value }, emailRedirectTo: `${location.origin}/me` } })
    message.value = error?.message ?? (data.session ? '注册成功。' : '验证邮件已发送，也可输入邮件中的 6 位验证码。')
    if (!error) data.session ? authRedirect() : step.value = 'verify'
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value })
    message.value = error?.message ?? '登录成功。'
    if (!error) authRedirect()
  }
  busy.value = false
}
async function sendOtp() {
  if (!supabase || !email.value) return
  const { error } = await supabase.auth.signInWithOtp({ email: email.value, options: { emailRedirectTo: `${location.origin}/me`, shouldCreateUser: props.mode === 'register' } })
  message.value = error?.message ?? '验证链接或验证码已发送。'
  if (!error) step.value = 'verify'
}
async function verify() {
  if (!supabase) return
  const { error } = await supabase.auth.verifyOtp({ email: email.value, token: otp.value, type: 'email' })
  message.value = error?.message ?? '邮箱验证成功。'
  if (!error) authRedirect()
}
async function github() {
  await supabase?.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: `${location.origin}/me` } })
}
</script>
<template><div class="fluent-page"><SiteHeader/><main class="auth-layout"><section class="auth-brand"><div class="auth-brand-mark"><ShieldCheck :size="34"/></div><p class="eyebrow">AETHER IDENTITY</p><h1>一个账户，连接产品、订单与协作空间。</h1><p>使用 Supabase Auth 持久化登录态。密码、邮箱验证与 GitHub OAuth 使用同一个账户体系。</p><div class="auth-proof"><BadgeCheck/><span><b>受保护的访问</b><small>订单归属、退款证据和管理员操作均由 RLS 校验。</small></span></div></section>
<section class="auth-card"><div v-if="!configured" class="fluent-notice">尚未配置 Supabase 浏览器环境变量。</div><template v-else><header><p>{{ mode === 'login' ? '欢迎回来' : '创建 AetherAC 账户' }}</p><h2>{{ mode === 'login' ? '登录' : '注册' }}</h2></header><form v-if="step==='form'" @submit.prevent="submit"><label v-if="mode==='register'">显示名称<div class="field"><input v-model="displayName" autocomplete="name" placeholder="你的名称"></div></label><label>邮箱<div class="field"><Mail :size="18"/><input v-model="email" type="email" autocomplete="email" required placeholder="name@example.com"></div></label><label>密码<div class="field"><LockKeyhole :size="18"/><input v-model="password" type="password" :autocomplete="mode==='login'?'current-password':'new-password'" minlength="8" required placeholder="至少 8 位"></div></label><button class="fluent-primary" :disabled="busy">{{ busy ? '正在处理…' : (mode==='login'?'登录':'创建账户') }}<ArrowRight :size="17"/></button><button class="fluent-secondary" type="button" @click="sendOtp"><Mail :size="17"/>通过邮箱链接 / 验证码</button><div class="auth-divider"><span>或</span></div><button class="github-auth" type="button" @click="github"><Github :size="19"/>使用 GitHub 继续</button></form><form v-else @submit.prevent="verify"><p class="verify-copy">我们已向 <b>{{email}}</b> 发送验证邮件。点击链接，或输入邮件中的验证码。</p><label>6 位验证码<div class="field"><input v-model="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></div></label><button class="fluent-primary">验证邮箱<ArrowRight :size="17"/></button><button class="fluent-secondary" type="button" @click="step='form'">返回</button></form><p class="form-message">{{message}}</p><footer>{{mode==='login'?'还没有账户？':'已经有账户？'}} <a :href="mode==='login'?'/register':'/login'">{{mode==='login'?'立即注册':'返回登录'}}</a></footer></template></section></main></div></template>
