<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowRight, BookOpen, Newspaper, Radio, Tag } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'
import { fetchPosts, formatDate, type ContentKind, type ContentPost } from './content'

const props = defineProps<{ kind: ContentKind }>()
const posts = ref<ContentPost[]>([])
const loading = ref(true)
const selected = ref<ContentPost | null>(null)
const source = ref<'cms' | 'fallback'>('fallback')
const title = computed(() => props.kind === 'blog' ? '工程 Blog' : '项目 News')
const lead = computed(() => props.kind === 'blog'
  ? '记录 AetherAC 的架构取舍、检测研究与工程方法。'
  : '发布里程碑、兼容性变化、测试计划与版本公告。')

onMounted(async () => {
  const result = await fetchPosts(props.kind)
  posts.value = result.data
  source.value = result.source
  const slug = new URLSearchParams(location.search).get('post')
  if (slug) selected.value = posts.value.find(post => post.slug === slug) ?? null
  loading.value = false
})

const openPost = (post: ContentPost) => {
  selected.value = post
  history.replaceState(null, '', `${location.pathname}?post=${post.slug}`)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

const closePost = () => {
  selected.value = null
  history.replaceState(null, '', location.pathname)
}
</script>

<template>
  <div class="dark-page">
    <SiteHeader />
    <main class="content-main">
      <section class="subpage-hero">
        <div class="hero-noise"></div>
        <div class="content-container">
          <div class="kicker"><Radio :size="14" /> AETHER TRANSMISSION / {{ kind.toUpperCase() }}</div>
          <h1>{{ title }}</h1>
          <p>{{ lead }}</p>
          <div class="source-status"><i></i>{{ source === 'cms' ? 'CMS LIVE' : 'LOCAL PREVIEW DATA' }}</div>
        </div>
      </section>

      <section v-if="selected" class="article-view content-container">
        <button class="back-link" @click="closePost">← 返回{{ title }}</button>
        <article>
          <div class="article-meta"><span>{{ selected.kind.toUpperCase() }}</span><time>{{ formatDate(selected.published_at) }}</time></div>
          <h2>{{ selected.title }}</h2>
          <p class="article-summary">{{ selected.summary }}</p>
          <div class="article-rule"></div>
          <p class="article-body">{{ selected.body }}</p>
          <div class="tag-list"><span v-for="tag in selected.tags" :key="tag"><Tag :size="12" />{{ tag }}</span></div>
        </article>
      </section>

      <section v-else class="post-section content-container">
        <div v-if="loading" class="loading-grid"><i v-for="i in 4" :key="i"></i></div>
        <div v-else class="post-grid">
          <article v-for="(post, index) in posts" :key="post.id" class="post-card" :class="{ featured: post.featured }">
            <div class="post-visual">
              <Newspaper v-if="kind === 'news'" :size="32" />
              <BookOpen v-else :size="32" />
              <span>0{{ index + 1 }}</span>
              <i></i>
            </div>
            <div class="post-meta"><time>{{ formatDate(post.published_at) }}</time><span>{{ post.tags[0] }}</span></div>
            <h2>{{ post.title }}</h2>
            <p>{{ post.summary }}</p>
            <button @click="openPost(post)">阅读全文 <ArrowRight :size="15" /></button>
          </article>
        </div>
      </section>
    </main>
    <SiteFooter />
  </div>
</template>
