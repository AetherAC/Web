<script setup lang="ts">
/**
 * §2.1 用户端客服挂件。
 *
 * 渠道由所在页面决定：/order 页里是售后（绑那一张订单），其余页面是售前（不绑订单）。
 * 这不是两个挂件，是同一个挂件在两处取不同的 channel——做成两个组件的话，
 * 「一个用户同时只有一条会话」这条约束会在两个组件之间打架。
 *
 * 未登录时只显示一个入口按钮，点了跳登录。不预先建会话：cs_sessions 上的 user_id 是必填的。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { Headset, MessageCircle, Minus, RefreshCw, X } from 'lucide-vue-next'
import CsThread from './CsThread.vue'
import { useAuth, supabase } from './auth'
import { csApi, useCsThread, type CsChannel } from './cs'

const auth = useAuth()
const thread = useCsThread()
const openPanel = ref(false)
const starting = ref(false)
const notice = ref('')
const unread = ref(0)

/** /order?order_id=… 是唯一的订单来源，和 OrderPage 读同一个地方。 */
function orderId(): string | null {
  if (typeof location === 'undefined') return null
  return new URLSearchParams(location.search).get('order_id')
}

const onOrderPage = computed(() =>
  typeof location !== 'undefined' && location.pathname.replace(/\/$/, '') === '/order' && !!orderId())

const channel = computed<CsChannel>(() => (onOrderPage.value ? 'postsale' : 'presale'))
const channelLabel = computed(() => (channel.value === 'postsale' ? '售后客服' : '售前咨询'))

/** 客服自己不需要这个挂件——他们用工作台。管理员同理。 */
const hidden = computed(() => auth.isStaff.value)

async function start() {
  if (!auth.user.value) { auth.requireUser(location.pathname + location.search); return }
  starting.value = true
  notice.value = ''
  try {
    const data = await thread.open(channel.value, orderId())
    if (!data.session.agent_id) notice.value = '正在为你接入客服，请稍候'
  } catch (e: any) {
    notice.value = e.message
  } finally {
    starting.value = false
  }
}

async function toggle() {
  openPanel.value = !openPanel.value
  if (openPanel.value) {
    unread.value = 0
    if (!thread.session.value) await start()
    else await thread.refresh()
  }
}

/** §2.5 用户侧主动关闭。关掉之后按钮变成「重新发起」。 */
async function closeSession() {
  if (!thread.session.value) return
  if (!confirm('关闭这次会话？之后可以重新发起，会尽量还是同一位客服。')) return
  try {
    await csApi('/api/cs-session', {
      method: 'POST',
      body: JSON.stringify({ action: 'close', session_id: thread.session.value.id, reason: 'user' })
    })
    await thread.refresh()
  } catch (e: any) { notice.value = e.message }
}

/** §2.5 重开。同一个客服由服务端决定，这里只发请求。 */
async function reopen() {
  if (!thread.session.value) return
  try {
    const data = await csApi('/api/cs-session', {
      method: 'POST',
      body: JSON.stringify({ action: 'reopen', session_id: thread.session.value.id })
    })
    thread.session.value = data.session
    await thread.refresh()
  } catch (e: any) { notice.value = e.message }
}

/** 面板收起时来的消息记成红点。展开时不记——那时用户正在看。 */
watch(() => thread.messages.value.length, (now, before) => {
  if (!openPanel.value && now > (before || 0)) unread.value += now - (before || 0)
})

/**
 * 进页面先探一次有没有在开的会话，好让红点在用户没点开挂件时也能出现。
 * 用 GET /api/cs-session 拿不到——那个接口是 POST-only 的，而 open 会建一条新会话。
 * 所以直接读 cs_sessions：浏览器对自己的会话有读权限（cs_sessions_read）。
 */
async function probe() {
  if (!auth.user.value || hidden.value || !supabase) return
  let q = supabase.from('cs_sessions').select('id,channel,order_id,status')
    .eq('user_id', auth.user.value.id).eq('status', 'open').eq('channel', channel.value)
  q = onOrderPage.value ? q.eq('order_id', orderId()) : q.is('order_id', null)
  const { data } = await q.maybeSingle()
  if (data?.id) {
    await thread.attach(data.id)
    // 未读只算客服那侧、用户还没读过的。
    unread.value = thread.messages.value.filter(
      m => m.sender_role !== 'user' && m.sender_role !== 'system' && !m.read_by_user_at).length
  }
}

watch(() => auth.ready.value, ready => { if (ready) probe() }, { immediate: true })
// 在 /order 之间切换订单时渠道的绑定对象变了，要重新探一次。
watch(channel, () => { openPanel.value = false; probe() })
onMounted(() => { if (auth.ready.value) probe() })
</script>

<template>
<div v-if="!hidden" class="cs-widget">
  <transition name="cs-pop">
    <section v-if="openPanel" class="cs-panel fluent-page">
      <header class="cs-panel-head">
        <div>
          <p class="eyebrow">{{ channelLabel }}</p>
          <h3>{{ thread.session.value?.agent_id ? '客服已接入' : '在线客服' }}</h3>
        </div>
        <button title="刷新" @click="thread.refresh()"><RefreshCw :size="16" /></button>
        <button v-if="thread.session.value && !thread.closed.value" title="关闭会话" @click="closeSession">
          <X :size="16" />
        </button>
        <button title="收起" @click="openPanel = false"><Minus :size="16" /></button>
      </header>

      <p v-if="notice" class="cs-notice">{{ notice }}</p>

      <div v-if="!thread.session.value" class="cs-start">
        <Headset :size="30" />
        <p>{{ channel === 'postsale' ? '这单有问题？售后客服会看到你的订单信息。' : '有问题随时问，售前客服会尽快回复。' }}</p>
        <button class="fluent-primary" :disabled="starting" @click="start">
          {{ starting ? '正在接入…' : '开始对话' }}
        </button>
      </div>

      <CsThread v-else :thread="thread"
        :placeholder="channel === 'postsale' ? '描述这单遇到的问题…' : '想问什么？'">
        <template #closed-action>
          <button class="fluent-secondary" @click="reopen">重新发起</button>
        </template>
      </CsThread>
    </section>
  </transition>

  <button class="cs-launcher" :class="{ active: openPanel }" :title="channelLabel" @click="toggle">
    <MessageCircle :size="22" />
    <em v-if="unread && !openPanel">{{ unread > 99 ? '99+' : unread }}</em>
  </button>
</div>
</template>
