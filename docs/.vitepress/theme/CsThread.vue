<script setup lang="ts">
/**
 * 一条会话的消息列表 + 输入框。用户端挂件和客服端工作台共用这一个组件。
 *
 * 为什么共用：撤回后的呈现、编辑痕迹、自动回复的标注、附件的签名 URL 这四件事在两端必须一致，
 * 而它们又都是「看起来只是显示」的逻辑。各写一遍的结果是客服那侧看到「[已撤回]」而用户那侧
 * 仍然显示原文——那正是 §2.11 要防的。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { CornerUpLeft, Download, Eye, Image as ImageIcon, Paperclip, Pencil, Send, Undo2, X } from 'lucide-vue-next'
import { renderRichBody } from './markdown'
import { csTime, formatBytes, mutable, type CsMessage } from './cs'
import { useAuth } from './auth'

const props = defineProps<{
  thread: any
  /** staff 侧多出撤回原文、编辑历史、内部消息这些东西。 */
  staff?: boolean
  placeholder?: string
  /** readonly 模式下管理员只看不发（§2.10）。 */
  readonly?: boolean
}>()

const auth = useAuth()
const draft = ref('')
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
const canPost = computed(() => props.thread.canPost.value && !props.readonly)
const myId = computed(() => auth.user.value?.id)

/** 自己发的靠右。管理员以客服名义发的那条，客服看到的也是「自己发的」——那是 §2.10 的本意。 */
const isMine = (m: CsMessage) => !!myId.value && m.sender_id === myId.value
const isSystem = (m: CsMessage) => m.sender_role === 'system'

const ROLE_LABEL: Record<string, string> = {
  user: '我', agent: '客服', admin: '管理员', system: '系统', auto: '自动回复'
}
const roleName = (m: CsMessage) => {
  if (isMine(m)) return '我'
  if (m.auto_reply) return '自动回复'
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

/** 附件的签名 URL 是异步取的，取到之后填进这个 map，模板里按 path 取。 */
async function ensureUrl(path: string) {
  if (urls.value[path]) return
  const url = await props.thread.signedUrl(path, 600)
  if (url) urls.value = { ...urls.value, [path]: url }
}

watch(messages, list => {
  for (const m of list) for (const a of m.attachments || []) ensureUrl(a.path)
  scrollDown()
}, { deep: false })

function scrollDown() {
  nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

onMounted(scrollDown)

async function submit() {
  const text = draft.value
  if (!text.trim() && props.thread.pending.value.length === 0) return
  draft.value = ''
  try { await props.thread.send(text) } catch { draft.value = text }
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
            {{ isMine(m) ? '你撤回了一条消息' : '对方撤回了一条消息' }}
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
                <img v-if="urls[a.path]" :src="urls[a.path]" :alt="a.name">
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
            <button v-if="staff && m.revisions?.length" title="查看历史"
              @click="showHistory = { ...showHistory, [m.id]: !showHistory[m.id] }">
              <Eye :size="14" />{{ m.revisions.length }}
            </button>
          </footer>

          <div v-if="staff && showHistory[m.id] && m.revisions?.length" class="cs-revisions">
            <p v-for="r in m.revisions" :key="r.revision">
              <b>{{ r.kind === 'recall' ? '撤回前' : `第 ${r.revision} 版` }}</b>
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
  <div v-else-if="!canPost" class="cs-closed">
    <span>{{ readonly ? '只读介入：你可以看到对话，但不能发言' : '当前无法在此会话中发言' }}</span>
  </div>
  <form v-else class="cs-composer" @submit.prevent="submit">
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
