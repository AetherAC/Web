<script setup lang="ts">
/**
 * 一条会话的消息列表 + 输入框。用户端挂件和客服端工作台共用这一个组件。
 *
 * 为什么共用：撤回后的呈现、编辑痕迹、自动回复的标注、附件的签名 URL 这四件事在两端必须一致，
 * 而它们又都是「看起来只是显示」的逻辑。各写一遍的结果是客服那侧看到「[已撤回]」而用户那侧
 * 仍然显示原文——那正是 §2.11 要防的。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  CornerUpLeft, Download, Eye, Image as ImageIcon, Paperclip, Pencil, Send, Undo2, X
} from 'lucide-vue-next'
import { renderRichBody } from './markdown'
import { csTime, formatBytes, mutable, type CsMessage } from './cs'
import { useAuth } from './auth'
import LdcPanel from './LdcPanel.vue'

const props = defineProps<{
  thread: any
  /** staff 侧多出撤回原文、编辑历史、内部消息这些东西。 */
  staff?: boolean
  placeholder?: string
}>()

const auth = useAuth()
const draft = ref('')
const ldcOpen = ref(false)
const editing = ref<string | null>(null)
const editDraft = ref('')
const scroller = ref<HTMLElement | null>(null)
const urls = ref<Record<string, string>>({})
const showHistory = ref<Record<string, boolean>>({})
const fileInput = ref<HTMLInputElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)

const messages = computed<CsMessage[]>(() => props.thread.messages.value)
const config = computed(() => props.thread.config.value)
const session = computed(() => props.thread.session.value)
const canPost = computed(() => props.thread.canPost.value)
const myId = computed(() => auth.user.value?.id)
/** 看这条会话的人站在哪一侧。用户端只有一种，客服端包括接待客服和在旁边看的管理员。 */
const ownerSide = computed(() => !!props.thread.isOwner.value)

/**
 * 靠右显示的是「我这一侧」发的，而不是「我这个账号」发的。
 *
 * 按 sender_id 比对会漏掉两种消息，而它们都该在右边：自动回复挂在接待客服名下（还没分配到人时
 * sender_id 干脆是空的），以及管理员在会话里说的话——客服那一侧的对话框里，那些都是「我们这边发出去的」。
 * 漏掉的表现是客服看着自己那条自动回复站在对面说话。
 *
 * 站哪一侧和署谁的名是两件事，所以称呼由 roleName 单独算：管理员的消息在客服那侧靠右，但标的是「管理员」。
 */
const isMine = (m: CsMessage) => (ownerSide.value
  ? m.sender_role === 'user'
  : m.sender_role === 'agent' || m.sender_role === 'admin' || m.sender_role === 'auto')
const isMyAccount = (m: CsMessage) => !!myId.value && m.sender_id === myId.value
const isSystem = (m: CsMessage) => m.sender_role === 'system'

const ROLE_LABEL: Record<string, string> = {
  user: '用户', agent: '客服', admin: '管理员', system: '系统', auto: '自动回复'
}

/**
 * 气泡上的称呼。
 *
 * 「我」只出现在真的是自己那个账号发的消息上。ROLE_LABEL.user 原来是「我」，于是客服打开对话时，
 * 用户说的每一句都标着「我」——两个人的话看起来都是同一个人说的。
 *
 * 名字优先用接口带回来的 agent_name / user_name：浏览器查不到对面叫什么（profiles_read 只让人读自己
 * 那一行），所以那两个字段是唯一来源，取不到时退回身份名。
 */
const roleName = (m: CsMessage) => {
  if (m.delivery === 'sending') return '发送中…'
  if (m.auto_reply) return '自动回复'
  if (m.sender_role === 'user') return ownerSide.value ? '我' : (session.value?.user_name || '用户')
  if (m.sender_role === 'admin') return isMyAccount(m) ? '我' : '管理员'
  if (m.sender_role === 'agent') {
    // 管理员在「正常介入」下代发的那条，sender_id 是接待客服自己——客服看到的就该是「我」（§2.10 的本意），
    // 旁边的「代发」标记只给 staff 看。
    if (!ownerSide.value && isMyAccount(m)) return '我'
    return session.value?.agent_name || '客服'
  }
  return ROLE_LABEL[m.sender_role] || m.sender_role
}

/**
 * §4 的四种格式。判定和四个渲染器都在 theme/markdown.ts 里，这里只多一条撤回的早退：
 * 撤回后的正文一个字都不能渲染，而 §9 的站内信没有撤回这回事，所以那一条留在组件里。
 */
function bodyHtml(m: CsMessage) {
  if (m.recalled) return ''
  return renderRichBody(m.body, m.format)
}

/**
 * 附件的签名 URL。一批一起签，见 cs.ts 的 signedUrls。
 *
 * 逐个签的话，一条带十张图的消息是十次往返，而每张图都要等自己那次回来才开始下载——看起来就是
 * 「图片加载很慢」。已经签过的不再签（cs.ts 那层还有一层缓存），撤回的消息不签：它的附件已经搬走了。
 */
async function ensureUrls(list: CsMessage[]) {
  const paths = list
    .flatMap(m => (m.recalled ? [] : (m.attachments || []).map(a => a.path)))
    .filter(p => p && !urls.value[p])
  if (!paths.length) return
  const map = await props.thread.signedUrls(paths, 900)
  if (Object.keys(map).length) urls.value = { ...urls.value, ...map }
}

watch(messages, list => {
  ensureUrls(list)
  scrollDown()
}, { deep: false })

function scrollDown() {
  nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

onMounted(() => {
  // 组件挂载时列表可能已经有内容（工作台切回一条读过的会话），那时上面那个 watch 不会触发。
  ensureUrls(messages.value)
  scrollDown()
})

async function submit() {
  if (props.thread.sending.value) return
  const text = draft.value
  if (!text.trim() && props.thread.pending.value.length === 0) return
  draft.value = ''
  const id = session.value?.id
  try { await props.thread.send(text) } catch { if (session.value?.id === id) draft.value = text }
}

function keydown(event: KeyboardEvent) {
  // Enter 发送、Shift+Enter 换行。输入法组字过程中的 Enter 不能算发送——那会在选词时把半句话发出去。
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
    return
  }
  if (config.value.typing_trigger === 'keypress') props.thread.notifyTyping()
}

function startEdit(m: CsMessage) {
  editing.value = m.id
  editDraft.value = m.body
}

async function commitEdit() {
  if (!editing.value) return
  const id = editing.value
  const body = editDraft.value
  editing.value = null
  await props.thread.edit(id, body)
}

const canMutate = (m: CsMessage) => mutable(m, myId.value, config.value.mutable_window_ms)

/**
 * §2.11 客服那侧的「查看历史」。
 *
 * 接口发过来的是两个字段而不是一个列表：recalled_body（撤回前的原文）和 edit_history（每一版的正文），
 * 见 shared/cs.mjs 的 presentMessage。这里把它们合成一份给模板用——原来模板读的是 m.revisions，
 * 那个名字接口从来没发过，于是这个按钮永远不出现，编辑痕迹在工作台上等于不存在。
 *
 * 撤回前的原文排在最前：一条被撤回的消息里，客服真正要看的就是它。
 */
function historyOf(m: CsMessage) {
  const rows: Array<{ key: string; label: string; body: string; created_at: string }> = []
  if (m.recalled_body !== undefined && m.recalled_body !== null) {
    rows.push({ key: `${m.id}:recall`, label: '撤回前', body: m.recalled_body, created_at: m.created_at })
  }
  for (const r of m.edit_history || []) {
    rows.push({ key: `${m.id}:${r.revision}`, label: `第 ${r.revision} 版`, body: r.body, created_at: r.created_at })
  }
  return rows
}

async function pick(event: Event) {
  const input = event.target as HTMLInputElement
  for (const file of Array.from(input.files || [])) await props.thread.upload(file)
  input.value = ''
}

const limitHint = computed(() => {
  const l = config.value.upload_limit_mb
  return `图片 ≤ ${l.image} MB · 文件 ≤ ${l.file} MB · 视频 ≤ ${l.video} MB`
})

const timeoutHint = computed(() => {
  if (!session.value) return ''
  const mins = config.value.timeout_minutes[session.value.channel]
  return mins ? `${mins} 分钟无新消息会自动关闭，可随时重新发起` : ''
})
</script>

<template>
<div class="cs-thread">
  <details v-if="session?.id" class="cs-ldc" @toggle="ldcOpen = ($event.target as HTMLDetailsElement).open"><summary>LDC 服务请求与付款确认</summary><LdcPanel v-if="ldcOpen" :key="session.id" :session-id="session.id" :staff="staff" :can-request="canPost"/></details>
  <div ref="scroller" class="cs-scroll">
    <p v-if="thread.loading.value && !messages.length" class="cs-hint">正在载入对话…</p>
    <p v-else-if="!messages.length" class="cs-hint">还没有消息。说明你的问题，客服会尽快回复。</p>

    <template v-for="m in messages" :key="m.id">
      <div v-if="isSystem(m)" class="cs-system">
        <span>{{ m.body }}</span>
        <small v-if="staff && m.visible_to_user === false">仅客服可见</small>
      </div>
      <article v-else class="cs-row" :class="{ mine: isMine(m) }">
        <div class="cs-bubble" :class="{ recalled: m.recalled, auto: m.auto_reply }">
          <header>
            <b>{{ roleName(m) }}</b>
            <small v-if="m.auto_reply">自动</small>
            <small v-if="staff && m.authored_by">代发</small>
            <time>{{ csTime(m.created_at) }}</time>
          </header>

          <p v-if="m.recalled" class="cs-recalled">
            {{ isMyAccount(m) ? '你撤回了一条消息' : '对方撤回了一条消息' }}
          </p>
          <div v-else-if="editing === m.id" class="cs-edit">
            <textarea v-model="editDraft" rows="3"></textarea>
            <div class="cs-edit-row">
              <button class="fluent-primary" @click="commitEdit">保存</button>
              <button class="fluent-secondary" @click="editing = null">取消</button>
            </div>
          </div>
          <div v-else class="cs-body markdown-body" v-html="bodyHtml(m)"></div>

          <div v-if="m.attachments?.length && !m.recalled" class="cs-attachments">
            <template v-for="a in m.attachments" :key="a.path">
              <a v-if="a.kind === 'image'" class="cs-image" :href="urls[a.path]" target="_blank" rel="noopener">
                <img v-if="urls[a.path]" :src="urls[a.path]" :alt="a.name" loading="lazy" decoding="async">
                <span v-else>图片载入中…</span>
              </a>
              <video v-else-if="a.kind === 'video' && urls[a.path]" :src="urls[a.path]" controls preload="metadata"></video>
              <a v-else class="cs-file" :href="urls[a.path]" target="_blank" rel="noopener" :download="a.name">
                <Download :size="16" /><b>{{ a.name || '附件' }}</b><small>{{ formatBytes(a.size) }}</small>
              </a>
            </template>
          </div>

          <footer>
            <small v-if="m.edited_at" class="cs-edited">已编辑</small>
            <button v-if="canMutate(m) && !m.recalled" title="撤回" @click="thread.recall(m.id)">
              <Undo2 :size="14" />
            </button>
            <button v-if="canMutate(m) && !m.recalled" title="编辑" @click="startEdit(m)">
              <Pencil :size="14" />
            </button>
            <button v-if="staff && historyOf(m).length" title="查看历史"
              @click="showHistory = { ...showHistory, [m.id]: !showHistory[m.id] }">
              <Eye :size="14" />{{ historyOf(m).length }}
            </button>
          </footer>

          <div v-if="staff && showHistory[m.id] && historyOf(m).length" class="cs-revisions">
            <p v-for="r in historyOf(m)" :key="r.key">
              <b>{{ r.label }}</b>
              <span>{{ r.body || '（空）' }}</span>
              <time>{{ csTime(r.created_at) }}</time>
            </p>
          </div>
        </div>
      </article>
    </template>

    <p v-if="thread.peerTyping.value" class="cs-typing">
      <i /><i /><i />{{ thread.isOwner.value ? '客服' : '用户' }}正在输入…
    </p>
  </div>

  <div v-if="thread.pending.value.length || thread.uploading.value.length" class="cs-pending">
    <span v-for="name in thread.uploading.value" :key="name" class="cs-uploading">{{ name }} 上传中…</span>
    <span v-for="a in thread.pending.value" :key="a.path">
      <Paperclip :size="14" />{{ a.name }}<small>{{ formatBytes(a.size) }}</small>
      <button title="移除" @click="thread.dropPending(a.path)"><X :size="13" /></button>
    </span>
  </div>

  <p v-if="thread.error.value" class="cs-error">{{ thread.error.value }}</p>

  <div v-if="thread.closed.value" class="cs-closed">
    <CornerUpLeft :size="16" />
    <span>{{ session?.timed_out ? '会话因超时已自动关闭' : '会话已关闭' }}</span>
    <slot name="closed-action" />
  </div>
  <div v-if="!thread.closed.value && !canPost" class="cs-closed">
    <span>当前无法在此会话中发言</span>
  </div>
  <form v-else-if="!thread.closed.value" class="cs-composer" @submit.prevent="submit">
    <textarea v-model="draft" :maxlength="config.message_max_chars"
      :placeholder="placeholder || '输入消息，Enter 发送，Shift+Enter 换行'"
      rows="2" @keydown="keydown" @focus="config.typing_trigger === 'focus' && thread.notifyTyping()"></textarea>
    <div class="cs-composer-row">
      <button type="button" :title="`插入图片（${limitHint}）`" @click="imageInput?.click()">
        <ImageIcon :size="17" />
      </button>
      <button type="button" :title="`插入附件（${limitHint}）`" @click="fileInput?.click()">
        <Paperclip :size="17" />
      </button>
      <small class="cs-limit">{{ timeoutHint }}</small>
      <span class="cs-count" :class="{ near: draft.length > config.message_max_chars - 200 }">
        {{ draft.length }}/{{ config.message_max_chars }}
      </span>
      <button class="fluent-primary" :disabled="thread.sending.value">
        <Send :size="16" />{{ thread.sending.value ? '发送中' : '发送' }}
      </button>
    </div>
    <input ref="imageInput" type="file" accept="image/*" multiple hidden @change="pick">
    <input ref="fileInput" type="file" multiple hidden @change="pick">
  </form>
</div>
</template>
<style scoped>
.cs-ldc{flex:none;max-height:55%;overflow:auto;border-bottom:1px solid var(--fluent-stroke)}
.cs-ldc>summary{padding:10px 16px;cursor:pointer;color:var(--fluent);background:var(--fluent-layer);font-size:13px}
</style>
