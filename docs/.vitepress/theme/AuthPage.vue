<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Github, LockKeyhole, Mail, ShieldCheck, ArrowRight, BadgeCheck } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import { authRedirect, supabase, useAuth } from './auth'
import { ldcApi, linuxdoLogin } from './ldc'
const linuxdoEnabled = ref(false)
onMounted(async () => {
  const error = new URLSearchParams(location.hash.slice(1)).get('error_description') || new URLSearchParams(location.search).get('error_description')
  if (error) message.value = error
  try { linuxdoEnabled.value = (await ldcApi({}, '?view=config')).linuxdo_enabled } catch { /* Existing login methods remain available. */ }
})
async function linuxdo() {
  busy.value = true; message.value = ''
  try { await linuxdoLogin() } catch (e: any) { message.value = e.message }
  finally { busy.value = false }
}
const props = defineProps<{ mode: 'login' | 'register' }>()
const { configured } = useAuth()
const email = ref(''); const password = ref(''); const displayName = ref('')
/**
 * 邮箱验证只走链接，不再有验证码。
 *
 * 这里原来还有一个 6 位验证码的输入框和 verifyOtp 那条路。问题不在前端：注册信里从来没有过验证码，
 * 模板里只有那条确认链接，于是那个输入框收不到任何能填进去的东西——用户对着一个永远填不出来的框，
 * 而真正能用的做法（点邮件里的链接）被它盖住了。两条路里留能用的那条。
 *
 * step 保留，但第二步不再是「输码」而是「去邮箱点链接」的说明加一个重发按钮。
 */
const step = ref<'form' | 'sent'>('form'); const busy = ref(false); const message = ref('')
async function submit() {
  if (!supabase) return
  busy.value = true; message.value = ''
  if (props.mode === 'register') {
    const { data, error } = await supabase.auth.signUp({ email: email.value, password: password.value, options: { data: { display_name: displayName.value }, emailRedirectTo: `${location.origin}/me` } })
    message.value = error?.message ?? (data.session ? '注册成功。' : '验证邮件已发送，点开邮件里的链接即可完成验证。')
    if (!error) data.session ? authRedirect() : step.value = 'sent'
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value })
    message.value = error?.message ?? '登录成功。'
    if (!error) authRedirect()
  }
  busy.value = false
}
/**
 * 无密码登录 / 重发验证邮件。
 *
 * 方法名还是 signInWithOtp——那是 SDK 的叫法，发出去的是一封带链接的邮件。这里只用链接那一半。
 * 邮箱空着时先说一句：不说的话表现是点了按钮什么都没发生。
 */
async function sendLink() {
  if (!supabase) return
  if (!email.value) { message.value = '请先填写邮箱。'; return }
  busy.value = true
  const { error } = await supabase.auth.signInWithOtp({ email: email.value, options: { emailRedirectTo: `${location.origin}/me`, shouldCreateUser: props.mode === 'register' } })
  message.value = error?.message ?? '邮件已发送，请到邮箱里点开那条链接。'
  if (!error) step.value = 'sent'
  busy.value = false
}
async function github() {
  await supabase?.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: `${location.origin}/me` } })
}
</script>
<template>
  <div class="fluent-page"><SiteHeader/><main class="auth-layout">
    <section class="auth-brand">
      <div class="auth-brand-mark"><ShieldCheck :size="34"/></div><p class="eyebrow">AETHER IDENTITY</p>
      <h1>一个账户，连接产品、订单与协作空间。</h1>
      <p>密码、邮箱验证、GitHub 与 Linux.DO 登录使用同一套 Supabase 账户体系。已有账户可登录后绑定 Linux.DO，保留订单。</p>
      <div class="auth-proof"><BadgeCheck/><span><b>受保护的访问</b><small>订单归属、退款证据和管理员操作均由 RLS 校验。</small></span></div>
    </section>
    <section class="auth-card">
      <div v-if="!configured" class="fluent-notice">尚未配置 Supabase 浏览器环境变量。</div>
      <template v-else>
        <header><p>{{ mode === 'login' ? '欢迎回来' : '创建 AetherAC 账户' }}</p><h2>{{ mode === 'login' ? '登录' : '注册' }}</h2></header>
        <form v-if="step==='form'" @submit.prevent="submit">
          <label v-if="mode==='register'">显示名称<div class="field"><input v-model="displayName" autocomplete="name" placeholder="你的名称"></div></label>
          <label>邮箱<div class="field"><Mail :size="18"/><input v-model="email" type="email" autocomplete="email" required placeholder="name@example.com"></div></label>
          <label>密码<div class="field"><LockKeyhole :size="18"/><input v-model="password" type="password" :autocomplete="mode==='login'?'current-password':'new-password'" minlength="8" required placeholder="至少 8 位"></div></label>
          <button class="fluent-primary" :disabled="busy">{{ busy ? '正在处理…' : (mode==='login'?'登录':'创建账户') }}<ArrowRight :size="17"/></button>
          <button class="fluent-secondary" type="button" :disabled="busy" @click="sendLink"><Mail :size="17"/>通过邮箱链接登录</button>
          <div class="auth-divider"><span>或</span></div>
          <button class="github-auth" type="button" :disabled="busy" @click="github"><Github :size="19"/>使用 GitHub 继续</button>
          <button v-if="linuxdoEnabled" class="fluent-secondary" type="button" :disabled="busy" @click="linuxdo"><ShieldCheck :size="19"/>使用 Linux.DO 继续</button>
        </form>
        <form v-else @submit.prevent="sendLink"><p class="verify-copy">我们已向 <b>{{email}}</b> 发送了一封邮件。点开里面的链接即可完成验证并登录。没收到请检查垃圾邮件，或重新发送。</p><button class="fluent-primary" :disabled="busy"><Mail :size="17"/>{{ busy ? '正在发送…' : '重新发送链接' }}</button><button class="fluent-secondary" type="button" @click="step='form'">返回</button></form>
        <p class="form-message" role="status">{{message}}</p><footer>{{mode==='login'?'还没有账户？':'已经有账户？'}} <a :href="mode==='login'?'/register':'/login'">{{mode==='login'?'立即注册':'返回登录'}}</a></footer>
      </template>
    </section>
  </main></div>
</template>
