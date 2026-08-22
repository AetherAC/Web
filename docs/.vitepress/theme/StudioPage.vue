<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { FileText, LogIn, LogOut, Plus, Radio, Save, Settings2, Trash2 } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const configured = computed(() => Boolean(url && key))
const client = ref<SupabaseClient | null>(null)
const user = ref<User | null>(null)
const email = ref('')
const message = ref('')
const tab = ref<'posts' | 'progress'>('posts')
const items = ref<any[]>([])
const editing = ref<any>(null)

onMounted(async () => {
  if (!url || !key) return
  client.value = createClient(url, key)
  const { data } = await client.value.auth.getUser()
  user.value = data.user
  client.value.auth.onAuthStateChange((_event, session) => { user.value = session?.user ?? null })
  if (user.value) await loadItems()
})

async function login() {
  if (!client.value || !email.value) return
  const { error } = await client.value.auth.signInWithOtp({ email: email.value, options: { emailRedirectTo: `${location.origin}/studio` } })
  message.value = error ? error.message : '登录链接已发送，请检查邮箱。'
}

async function logout() {
  await client.value?.auth.signOut()
  user.value = null
  items.value = []
}

async function loadItems() {
  if (!client.value) return
  const table = tab.value === 'posts' ? 'posts' : 'progress_entries'
  const { data, error } = await client.value.from(table).select('*').order(tab.value === 'posts' ? 'updated_at' : 'sort_order', { ascending: tab.value !== 'posts' })
  message.value = error?.message ?? ''
  items.value = data ?? []
}

function createItem() {
  editing.value = tab.value === 'posts'
    ? { kind: 'news', title: '', slug: '', summary: '', body: '', tags: [], status: 'draft', featured: false, published_at: new Date().toISOString() }
    : { stage: '00', title: '', summary: '', percent: 0, status: 'planned', sort_order: items.value.length }
}

async function saveItem() {
  if (!client.value || !editing.value) return
  const table = tab.value === 'posts' ? 'posts' : 'progress_entries'
  const payload = { ...editing.value }
  if (typeof payload.tags === 'string') payload.tags = payload.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean)
  const { error } = await client.value.from(table).upsert(payload)
  message.value = error ? error.message : '已保存。'
  if (!error) { editing.value = null; await loadItems() }
}

async function removeItem(item: any) {
  if (!client.value || !confirm(`删除“${item.title}”？`)) return
  const table = tab.value === 'posts' ? 'posts' : 'progress_entries'
  const { error } = await client.value.from(table).delete().eq('id', item.id)
  message.value = error?.message ?? '已删除。'
  await loadItems()
}

async function switchTab(value: 'posts' | 'progress') {
  tab.value = value
  editing.value = null
  await loadItems()
}
</script>

<template>
  <div class="dark-page studio-page">
    <SiteHeader />
    <main class="content-main">
      <section class="subpage-hero studio-hero">
        <div class="hero-noise"></div>
        <div class="content-container"><div class="kicker"><Radio :size="14" /> CONTENT OPERATIONS</div><h1>Aether Studio</h1><p>管理 Blog、News 和公开开发进度。所有写入由 Supabase Auth 与 RLS 保护。</p></div>
      </section>

      <section class="studio-shell content-container">
        <div v-if="!configured" class="studio-state"><Settings2 :size="32" /><h2>CMS 尚未配置</h2><p>复制 <code>.env.example</code> 为 <code>.env.local</code>，填入 Supabase URL 与公开 anon key。</p></div>
        <div v-else-if="!user" class="studio-login"><LogIn :size="28" /><h2>管理员登录</h2><p>只有登记在 <code>site_admins</code> 表中的用户可以写入内容。</p><div><input v-model="email" type="email" placeholder="contact@aetherac.abnt.it" @keyup.enter="login"><button @click="login">发送登录链接</button></div><span>{{ message }}</span></div>
        <template v-else>
          <div class="studio-toolbar">
            <div class="studio-tabs"><button :class="{ active: tab === 'posts' }" @click="switchTab('posts')"><FileText :size="15" /> Blog / News</button><button :class="{ active: tab === 'progress' }" @click="switchTab('progress')"><Settings2 :size="15" /> 开发进度</button></div>
            <div><span>{{ user.email }}</span><button title="退出" @click="logout"><LogOut :size="16" /></button></div>
          </div>
          <div class="studio-grid">
            <div class="studio-list">
              <div class="studio-list-head"><span>{{ tab === 'posts' ? 'CONTENT' : 'ROADMAP STAGES' }}</span><button @click="createItem"><Plus :size="15" /> 新建</button></div>
              <article v-for="item in items" :key="item.id" @click="editing = { ...item, tags: item.tags?.join(', ') }">
                <div><span>{{ item.kind || item.stage }}</span><h3>{{ item.title }}</h3><small>{{ item.status }} · {{ item.percent ?? 0 }}%</small></div>
                <button title="删除" @click.stop="removeItem(item)"><Trash2 :size="14" /></button>
              </article>
            </div>
            <form v-if="editing" class="studio-editor" @submit.prevent="saveItem">
              <h2>{{ editing.id ? '编辑内容' : '新建内容' }}</h2>
              <template v-if="tab === 'posts'">
                <label>类型<select v-model="editing.kind"><option value="blog">Blog</option><option value="news">News</option></select></label>
                <label>标题<input v-model="editing.title" required></label>
                <label>Slug<input v-model="editing.slug" required placeholder="release-0-1-0"></label>
                <label>摘要<textarea v-model="editing.summary" rows="3" required></textarea></label>
                <label>正文<textarea v-model="editing.body" rows="9" required></textarea></label>
                <label>标签（逗号分隔）<input v-model="editing.tags"></label>
                <div class="editor-row"><label>状态<select v-model="editing.status"><option value="draft">Draft</option><option value="published">Published</option></select></label><label>发布日期<input v-model="editing.published_at" type="datetime-local"></label></div>
              </template>
              <template v-else>
                <div class="editor-row"><label>阶段<input v-model="editing.stage" required></label><label>排序<input v-model.number="editing.sort_order" type="number"></label></div>
                <label>标题<input v-model="editing.title" required></label>
                <label>说明<textarea v-model="editing.summary" rows="5" required></textarea></label>
                <div class="editor-row"><label>完成度<input v-model.number="editing.percent" type="number" min="0" max="100"></label><label>状态<select v-model="editing.status"><option value="planned">Planned</option><option value="active">Active</option><option value="complete">Complete</option><option value="paused">Paused</option></select></label></div>
              </template>
              <button class="save-button" type="submit"><Save :size="15" /> 保存</button><span>{{ message }}</span>
            </form>
            <div v-else class="studio-placeholder">选择一条内容或新建项目。</div>
          </div>
        </template>
      </section>
    </main>
    <SiteFooter />
  </div>
</template>
