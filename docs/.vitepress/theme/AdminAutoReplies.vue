<script setup lang="ts">
/**
 * §3 自动回复规则管理。后端是 api/_routes/admin-auto-replies.mjs；触发方式、匹配模式、正文格式的
 * 枚举和校验都来自 shared/cs.mjs——validateRule 就是接口调用的那一个，所以「界面说能存」和
 * 「接口回 400」不可能分叉。
 *
 * 门槛两档，跟接口一致：看是 staff（客服得知道用户正在收到什么），改是 admin。规则正文会发给每一个
 * 开会话的用户，所以写权限不给 cs。非管理员进来时表单照画、字段禁用并写明原因——藏起来只会让人以为
 * 这个功能不存在，然后自己动手在会话里手打同一段话。
 *
 * 这一页最要紧的是「触发试算」。同一句话命中多条规则时，pickAutoReply 只发优先级最高的那一条，于是
 * 新配的规则会被一条早就存在的规则安静压掉：它匹配得上，只是永远轮不到它。日志里看不出来，规则列表
 * 里也看不出来。所以这里拿全部规则加上正在编辑的这一条，跑一次发送时的同一个 pickAutoReply，直接
 * 说出「这句话会发哪条」，以及自己这条为什么没被选上。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { CircleAlert, Eye, MessageCircle, Plus, Save, Trash2, X, Zap } from 'lucide-vue-next'
import { useAuth } from './auth'
import { preloadMarkdown, renderRichBody } from './markdown'
import {
  AUTO_REPLY_BODY_MAX, AUTO_REPLY_CHANNELS, AUTO_REPLY_KEYWORD_CHARS, AUTO_REPLY_KEYWORD_MAX,
  AUTO_REPLY_PRIORITY_RANGE, AUTO_REPLY_TRIGGERS, MATCH_MODES, MESSAGE_FORMATS,
  matchesKeyword, pickAutoReply, validateRule
} from '../../../shared/cs.mjs'

const auth = useAuth()
const canWrite = computed(() => auth.isAdmin.value)

const TRIGGER_LABEL: Record<string, string> = {
  keyword: '用户说了某个关键词', order_paid: '订单支付成功后', session_open: '会话刚开启时'
}
const TRIGGER_NOTE: Record<string, string> = {
  keyword: '每条用户消息都会拿去比一次，命中就发。',
  order_paid: '支付回调确认收款之后发，发在该用户当前的会话里。',
  session_open: '用户点开客服窗口、会话建好的那一刻发，通常放欢迎语和排队说明。'
}
const CHANNEL_LABEL: Record<string, string> = {
  presale: '仅售前咨询', postsale: '仅售后咨询', both: '售前和售后都发'
}
const MODE_LABEL: Record<string, string> = {
  contains: '包含', exact: '完全等于', starts_with: '以…开头', ends_with: '以…结尾'
}
const FORMAT_LABEL: Record<string, string> = {
  plain: '纯文本', markdown: 'Markdown', bbcode: 'BBCode', html: 'HTML'
}
const [PRIORITY_MIN, PRIORITY_MAX] = AUTO_REPLY_PRIORITY_RANGE

const rows = ref<any[]>([])
const selected = ref<any>(null)
const isNew = ref(false)
const loading = ref(false)
const saving = ref(false)
const message = ref('')
const form = ref<any>(emptyForm())
const probeText = ref('我要退款')
const probeChannel = ref('presale')

function emptyForm() {
  return {
    name: '', enabled: true, trigger: 'session_open', channel: 'both',
    keywords: '', match_mode: 'contains', body: '', format: 'plain',
    once_per_session: true, priority: 0
  }
}

const kwIn = (list: any) => (Array.isArray(list) ? list.join('\n') : '')
const kwOut = (text: string) => String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)

function toForm(row: any) {
  return {
    name: row.name || '', enabled: row.enabled !== false,
    trigger: row.trigger || 'session_open', channel: row.channel || 'both',
    keywords: kwIn(row.keywords), match_mode: row.match_mode || 'contains',
    body: row.body || '', format: row.format || 'plain',
    once_per_session: row.once_per_session !== false, priority: Number(row.priority ?? 0)
  }
}

/**
 * 表单 → 完整的一条规则。
 *
 * 非关键词触发时 keywords 一律发空数组：把一条 keyword 规则改成 session_open 之后，库里留着的旧
 * 关键词不会再被读到，但下次有人把它改回 keyword，那些词会原地复活并立刻开始匹配。
 */
function payload() {
  const f = form.value
  return {
    name: String(f.name || '').trim(),
    enabled: f.enabled === true,
    trigger: f.trigger,
    channel: f.channel,
    keywords: f.trigger === 'keyword' ? kwOut(f.keywords) : [],
    match_mode: f.match_mode,
    body: String(f.body ?? ''),
    format: f.format,
    once_per_session: f.once_per_session === true,
    priority: Number(f.priority ?? 0)
  }
}

/**
 * 只发改动过的字段（接口的 update 支持部分字段就是为了这个）。整条回传的话，两个管理员同时开着
 * 同一条规则时，后保存的那个会把前一个的改动覆盖成自己打开页面时的旧值。
 */
function diff(original: any) {
  const next: any = payload()
  const patch: any = {}
  for (const key of Object.keys(next)) {
    const before = original[key]
    if (key === 'keywords') {
      if (JSON.stringify(before ?? []) !== JSON.stringify(next[key])) patch[key] = next[key]
      continue
    }
    if ((before ?? '') !== next[key]) patch[key] = next[key]
  }
  return patch
}

/** 用的是接口调用的同一个 validateRule。表单始终装着一条完整规则，所以按新建那档校验（partial 关掉）。 */
const localCheck = computed(() => validateRule(payload()))
const bodyLeft = computed(() => AUTO_REPLY_BODY_MAX - String(form.value.body || '').length)
/** 落库前会去重去空，这里当场把去完之后的样子摆出来——不然「填了 8 个词、存进去 5 个」没人看得懂。 */
const kwParsed = computed(() => [...new Set(kwOut(form.value.keywords))])
const kwTooLong = computed(() => kwParsed.value.filter(w => w.length > AUTO_REPLY_KEYWORD_CHARS))
const bodyHtml = computed(() => renderRichBody(form.value.body, form.value.format))

/**
 * 触发试算。
 *
 * 把正在编辑的这一条替换（或追加）进完整规则表，然后跑发送时的同一个 pickAutoReply。要的不是「我这条
 * 匹配吗」——那用 matchesKeyword 一行就够了——而是「这句话最后发的是哪条」，因为答案经常不是自己刚配
 * 的这条。once_per_session 按「全新会话」算：一个会话里发过没发过是运行时状态，这里没有。
 */
const draftId = computed(() => selected.value?.id || '__draft__')
const draftRule = computed(() => ({
  ...payload(),
  id: draftId.value,
  // 同优先级按创建时间取早的那条。新建的规则在真实排序里是最后一个，所以试算里也给它「现在」。
  created_at: selected.value?.created_at || new Date().toISOString()
}))
const probeRules = computed(() => [...rows.value.filter(r => r.id !== draftId.value), draftRule.value])
const probeWinner = computed(() => pickAutoReply(probeRules.value, {
  trigger: form.value.trigger,
  channel: probeChannel.value,
  text: probeText.value,
  alreadySentRuleIds: []
}))
/** 自己这条为什么没被选上，分三种：停用、渠道不对、关键词没中。三者的修法完全不同，所以要分开说。 */
const draftBlocked = computed(() => {
  const r = draftRule.value
  if (!r.enabled) return '这条规则现在是停用状态，任何情况下都不会发。'
  if (r.channel !== 'both' && r.channel !== probeChannel.value) {
    return `这条规则只发${CHANNEL_LABEL[r.channel]}，而试算选的是${probeChannel.value === 'presale' ? '售前' : '售后'}会话。`
  }
  if (r.trigger === 'keyword' && !matchesKeyword(probeText.value, r.keywords, r.match_mode)) {
    return `这句话没有${MODE_LABEL[r.match_mode]}任何一个关键词（匹配不分大小写，两端空格会被去掉）。`
  }
  return ''
})
const shadowedBy = computed(() =>
  !draftBlocked.value && probeWinner.value && probeWinner.value.id !== draftId.value ? probeWinner.value : null)
const ruleName = (r: any) => r?.name || '未命名规则'

async function api(path: string, options: any = {}) {
  const token = auth.session.value?.access_token
  const r = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`)
  return data
}
/** 读走 GET（staff 就能调），四个写动作都是 POST 带 action——接口就是这么分权限的。 */
const write = (action: string, extra: any = {}) =>
  api('/api/admin-auto-replies', { method: 'POST', body: JSON.stringify({ action, ...extra }) })

async function load() {
  loading.value = true
  try {
    rows.value = (await api('/api/admin-auto-replies')).rules || []
    message.value = rows.value.length ? '' : '还没有自动回复规则。点「新建」加第一条。'
  } catch (e: any) {
    rows.value = []
    message.value = e.message
  } finally {
    loading.value = false
  }
}

function choose(row: any) {
  selected.value = row
  isNew.value = false
  form.value = toForm(row)
  message.value = ''
}
function createRule() {
  selected.value = null
  isNew.value = true
  form.value = emptyForm()
  message.value = ''
}
function closeEditor() {
  selected.value = null
  isNew.value = false
  message.value = ''
}
/** 保存后把列表里那条新的读回来当基线，否则下一次 diff 会拿旧值比，得出一堆不存在的改动。 */
function rebind(id: string) {
  const fresh = rows.value.find(r => r.id === id)
  if (fresh) { selected.value = fresh; form.value = toForm(fresh); isNew.value = false }
}

async function save() {
  if (!localCheck.value.ok) { message.value = localCheck.value.error; return }
  saving.value = true
  try {
    if (isNew.value) {
      const { rule } = await write('create', payload())
      message.value = `已创建「${ruleName(rule)}」`
      await load()
      rebind(rule.id)
    } else {
      const patch = diff(selected.value)
      if (!Object.keys(patch).length) { message.value = '没有改动'; return }
      const { rule } = await write('update', { id: selected.value.id, ...patch })
      message.value = `已保存「${ruleName(rule)}」（本次改了 ${Object.keys(patch).join('、')}）`
      await load()
      rebind(rule.id)
    }
  } catch (e: any) {
    message.value = e.message
  } finally {
    saving.value = false
  }
}

/**
 * 删规则。cs_messages.auto_reply_rule_id 是 on delete set null，所以历史消息不会跟着消失，只是从此
 * 说不出自己是哪条规则发的。要「暂时不发」请用停用，那是可逆的。
 */
async function remove() {
  const row = selected.value
  if (!row) return
  if (!confirm(`删除「${ruleName(row)}」？历史消息会留下，但它们从此查不到自己是哪条规则发的。只想暂时不发请改用停用。`)) return
  try {
    await write('delete', { id: row.id })
    message.value = `已删除「${ruleName(row)}」`
    closeEditor()
  } catch (e: any) {
    message.value = e.message
  }
  await load()
}

async function toggleEnabled(row: any) {
  try {
    await write('update', { id: row.id, enabled: !row.enabled })
    message.value = `「${ruleName(row)}」已${row.enabled ? '停用' : '启用'}`
  } catch (e: any) {
    message.value = e.message
  }
  await load()
  if (selected.value?.id === row.id) rebind(row.id)
}

onMounted(() => { void preloadMarkdown() })
watch(() => auth.ready.value, ready => { if (ready && auth.user.value) void load() }, { immediate: true })
</script>

<template>
<div class="coupon-pane">
  <div v-if="!canWrite" class="fluent-notice compact">
    <b>这一页你是只读的</b>
    <p>
      规则正文会发给每一个开会话的用户，所以改规则只有 <code>admin</code> 能做——接口也是这么判的，
      不是前端把按钮藏了。客服能看这一页，是为了知道用户正在收到什么话：手上这个会话开头那句欢迎语
      是哪条规则发的、为什么发的，翻这里就有答案。
    </p>
  </div>

  <div class="admin-grid coupon-grid">
    <section class="records">
      <div class="section-toolbar">
        <div>
          <h2>{{ rows.length }} 条规则</h2>
          <p>列表顺序就是发送时的挑选顺序：先按触发方式分组，同组里优先级大的在前，同优先级取建得早的那条。</p>
        </div>
        <button v-if="canWrite" @click="createRule"><Plus :size="17" />新建</button>
      </div>
      <div v-if="loading" class="fluent-empty">加载中…</div>
      <article
        v-for="r in rows" :key="r.id"
        :class="{ selected: selected && selected.id === r.id }" @click="choose(r)">
        <div>
          <b>{{ ruleName(r) }}<em v-if="!r.enabled" class="coupon-off">已停用</em></b>
          <small>
            {{ TRIGGER_LABEL[r.trigger] }} · {{ CHANNEL_LABEL[r.channel] }} · 优先级 {{ r.priority }}
            · {{ FORMAT_LABEL[r.format] || r.format }}<template v-if="r.once_per_session"> · 每会话只发一次</template>
            <template v-if="r.trigger === 'keyword'">
              <br>{{ MODE_LABEL[r.match_mode] }}：{{ (r.keywords || []).slice(0, 6).join('、') || '（没有关键词，永远不会触发）'
              }}<template v-if="(r.keywords || []).length > 6"> 等 {{ r.keywords.length }} 个</template>
            </template>
          </small>
        </div>
        <button v-if="canWrite" :title="r.enabled ? '停用这条规则' : '启用这条规则'" @click.stop="toggleEnabled(r)">
          {{ r.enabled ? '停用' : '启用' }}
        </button>
      </article>
    </section>

    <section v-if="isNew || selected" class="record-editor coupon-editor">
      <div class="editor-title">
        <div>
          <p>{{ isNew ? 'NEW AUTO REPLY' : 'AUTO REPLY' }}</p>
          <h2>{{ isNew ? '新建自动回复' : ruleName(selected) }}</h2>
        </div>
        <button class="icon-button" title="关闭" @click="closeEditor"><X :size="18" /></button>
      </div>

      <form class="coupon-form" @submit.prevent="save">
        <fieldset class="ar-fields" :disabled="!canWrite">
          <div class="coupon-row">
            <label>规则名称
              <input v-model="form.name" maxlength="120" placeholder="售前欢迎语" />
              <small>只给后台看，用户看不到。留空会在列表里显示成「未命名规则」——三个月后没人认得出哪条是哪条。</small>
            </label>
            <label>优先级
              <input v-model.number="form.priority" type="number" step="1" :min="PRIORITY_MIN" :max="PRIORITY_MAX" />
              <small>{{ PRIORITY_MIN }}..{{ PRIORITY_MAX }} 的整数，越大越优先。一句话命中多条规则时只发优先级最高的一条。</small>
            </label>
          </div>

          <label>什么时候发
            <select v-model="form.trigger">
              <option v-for="t in AUTO_REPLY_TRIGGERS" :key="t" :value="t">{{ TRIGGER_LABEL[t] }}</option>
            </select>
            <small>{{ TRIGGER_NOTE[form.trigger] }}</small>
          </label>

          <label>发在哪个渠道
            <select v-model="form.channel">
              <option v-for="c in AUTO_REPLY_CHANNELS" :key="c" :value="c">{{ CHANNEL_LABEL[c] }}</option>
            </select>
            <small>一个会话只属于一个渠道，「都发」是指这条规则对两种会话都生效，不是发两遍。</small>
          </label>

          <template v-if="form.trigger === 'keyword'">
            <label>怎么算命中
              <select v-model="form.match_mode">
                <option v-for="m in MATCH_MODES" :key="m" :value="m">{{ MODE_LABEL[m] }}</option>
              </select>
              <small>匹配不分大小写：用户不会照着配置里的大小写打字。</small>
            </label>
            <label>关键词（每行一个）
              <textarea v-model="form.keywords" rows="4" placeholder="退款&#10;退钱&#10;refund"></textarea>
              <small>
                最多 {{ AUTO_REPLY_KEYWORD_MAX }} 个，单个不超过 {{ AUTO_REPLY_KEYWORD_CHARS }} 字。
                空行会被丢掉——空串在「包含」模式下匹配任何文本，等于让这条规则对每句话都触发。
              </small>
            </label>
            <p v-if="kwParsed.length" class="ar-chips">
              <span>存进去会是这 {{ kwParsed.length }} 个：</span><code v-for="w in kwParsed" :key="w">{{ w }}</code>
            </p>
            <p v-else class="coupon-none">还没有关键词。关键词触发但一个词都没有的规则永远不会命中，接口会拒绝保存。</p>
            <p v-if="kwTooLong.length" class="orders-hint">
              <CircleAlert :size="15" />有 {{ kwTooLong.length }} 个关键词超过 {{ AUTO_REPLY_KEYWORD_CHARS }} 字。
            </p>
          </template>

          <div class="coupon-row">
            <label>正文格式
              <select v-model="form.format">
                <option v-for="f in MESSAGE_FORMATS" :key="f" :value="f">{{ FORMAT_LABEL[f] }}</option>
              </select>
              <small>和客服手打的消息用同一套渲染（§4）。HTML 会在入库前过一遍白名单清洗，标签不在名单里的会被去掉。</small>
            </label>
            <label class="ar-inline-checks">
              <span class="check-row"><input v-model="form.enabled" type="checkbox" />启用</span>
              <span class="check-row"><input v-model="form.once_per_session" type="checkbox" />每个会话只发一次</span>
              <small>不勾「只发一次」的话，用户在同一个会话里每提一次「退款」就会再收到同一段话一遍。</small>
            </label>
          </div>

          <label>回复内容
            <textarea v-model="form.body" rows="7" :maxlength="AUTO_REPLY_BODY_MAX"
              placeholder="您好，已收到您的咨询。人工客服会在工作时间内回复；如果是订单问题，请把订单号发过来。"></textarea>
            <small>还能写 {{ bodyLeft }} 字。这段话会挂在客服名下发出，但不计入响应时间——自动回复不算「有人接了」。</small>
          </label>
        </fieldset>

        <!-- 预览用的是客服消息和站内信的同一个 renderRichBody，所以这里看到的就是用户会看到的。 -->
        <div class="coupon-preview ar-preview">
          <h3><Eye :size="16" />用户看到的样子</h3>
          <div v-if="form.body" class="ar-body" v-html="bodyHtml"></div>
          <p v-else class="coupon-none">正文还是空的。</p>
          <p v-if="form.format === 'markdown'" class="coupon-none">
            Markdown 渲染器是按需加载的：第一次打开这一页时可能先看到一版没有格式的纯文本，chunk 到了会自己换过来。
          </p>
        </div>

        <!-- 试算不在 fieldset 里：只读的客服也要能问「用户说这句话会收到什么」，那是他们看这一页的理由。 -->
        <div class="coupon-preview ar-probe">
          <h3><Zap :size="16" />触发试算</h3>
          <div class="coupon-row">
            <label>假设会话渠道是
              <select v-model="probeChannel">
                <option value="presale">售前咨询</option>
                <option value="postsale">售后咨询</option>
              </select>
            </label>
            <label v-if="form.trigger === 'keyword'">用户说了这句话
              <input v-model="probeText" placeholder="我要退款" />
            </label>
            <label v-else>触发方式
              <input :value="TRIGGER_LABEL[form.trigger]" readonly />
            </label>
          </div>
          <p v-if="form.trigger !== 'keyword'" class="coupon-none">
            这个触发方式跟用户说什么无关，所以没有句子可填——只比渠道、启用状态和优先级。
          </p>

          <p v-if="draftBlocked" class="ar-verdict ar-verdict-off">
            <CircleAlert :size="15" />这一条不会发：{{ draftBlocked }}
          </p>
          <p v-else-if="shadowedBy" class="ar-verdict ar-verdict-shadow">
            <CircleAlert :size="15" />这一条匹配得上，但发出去的会是「{{ ruleName(shadowedBy) }}」（优先级
            {{ shadowedBy.priority }}，本条 {{ form.priority }}）。同一句话只发优先级最高的一条，所以按现在的配置这条永远轮不到。
          </p>
          <p v-else-if="probeWinner" class="ar-verdict ar-verdict-hit">
            <Zap :size="15" />这一条会发出去。
          </p>
          <p v-else class="ar-verdict ar-verdict-off">
            <CircleAlert :size="15" />没有任何规则会触发，用户收不到自动回复。
          </p>
          <p class="coupon-none">
            试算跑的是发送时的同一个 pickAutoReply，规则表用的是列表里这些加上正在编辑的这一条（还没保存的改动也算进去）。
            按「全新会话」算：一个会话里哪条发过了是运行时状态，这里没有，所以「每会话只发一次」在试算里不起作用。
          </p>
        </div>

        <p v-if="!localCheck.ok" class="orders-hint"><CircleAlert :size="15" />{{ localCheck.error }}</p>
        <div v-if="canWrite" class="form-actions">
          <button class="fluent-primary" :disabled="saving || !localCheck.ok">
            <Save :size="17" />{{ saving ? '保存中…' : isNew ? '创建这条规则' : '保存改动' }}
          </button>
          <button v-if="!isNew" type="button" class="fluent-secondary" @click="choose(selected)">放弃修改</button>
          <button v-if="!isNew" type="button" class="fluent-secondary coupon-del" @click="remove">
            <Trash2 :size="17" />删除
          </button>
        </div>
      </form>
    </section>
    <div v-else class="fluent-empty"><MessageCircle :size="28" /><h2>选择一条规则，或新建一条</h2></div>
  </div>
  <p v-if="message" class="admin-message coupon-message">{{ message }}</p>
</div>
</template>
