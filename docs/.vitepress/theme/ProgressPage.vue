<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ArrowUpRight, CheckCircle2, CircleDot, Clock3, Github, GitPullRequest, Radio, RefreshCw } from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'
import { fetchProgress, formatDate, type ProgressEntry } from './content'

interface GithubProgress {
  configured: boolean
  repository?: { name: string; url: string; description?: string; updatedAt: string }
  totals?: { openIssues: number; closedIssues: number; milestones: number; completion: number }
  milestones?: Array<{ title: string; open: number; closed: number; percent: number; url: string }>
  recentIssues?: Array<{ number: number; title: string; state: string; url: string; labels: string[]; updatedAt: string }>
  message?: string
}

const stages = ref<ProgressEntry[]>([])
const cmsSource = ref('fallback')
const github = ref<GithubProgress | null>(null)
const syncing = ref(true)

onMounted(async () => {
  const cms = await fetchProgress()
  stages.value = cms.data
  cmsSource.value = cms.source
  const syncEnabled = location.hostname === 'aetherac.abnt.it' || import.meta.env.VITE_ENABLE_GITHUB_SYNC === 'true'
  if (!syncEnabled) {
    github.value = { configured: false, message: '本地静态预览未启用 GitHub 同步；生产域名会自动连接 Vercel API。' }
    syncing.value = false
    return
  }
  try {
    const response = await fetch('/api/github-progress')
    github.value = response.ok ? await response.json() : { configured: false, message: 'GitHub 同步接口尚未配置。' }
  } catch {
    github.value = { configured: false, message: '本地预览未连接 Vercel API。' }
  } finally {
    syncing.value = false
  }
})
</script>

<template>
  <div class="dark-page">
    <SiteHeader />
    <main class="content-main">
      <section class="subpage-hero progress-hero">
        <div class="hero-noise"></div>
        <div class="content-container">
          <div class="kicker"><Radio :size="14" /> BUILD TELEMETRY / LIVE ROADMAP</div>
          <h1>公开开发进度，<br><em>同步工程事实。</em></h1>
          <p>CMS 负责阶段说明与公开口径；GitHub API 自动同步里程碑、Issue 和最近开发活动。</p>
          <div class="source-status"><i></i>{{ cmsSource === 'cms' ? 'CMS CONNECTED' : 'CMS PREVIEW MODE' }}</div>
        </div>
      </section>

      <section class="progress-layout content-container">
        <div class="roadmap-panel">
          <div class="panel-heading"><div><span>01</span><h2>研发阶段</h2></div><small>MANAGED IN SUPABASE CMS</small></div>
          <div class="stage-list">
            <article v-for="stage in stages" :key="stage.id">
              <div class="stage-index">{{ stage.stage }}</div>
              <div class="stage-content">
                <div><h3>{{ stage.title }}</h3><span :class="`status-${stage.status}`">{{ stage.status }}</span></div>
                <p>{{ stage.summary }}</p>
                <div class="progress-track"><i :style="{ width: `${stage.percent}%` }"></i></div>
              </div>
              <strong>{{ stage.percent }}%</strong>
            </article>
          </div>
        </div>

        <aside class="github-panel">
          <div class="panel-heading"><div><Github :size="19" /><h2>GitHub Sync</h2></div><RefreshCw :size="15" :class="{ spinning: syncing }" /></div>
          <div v-if="syncing" class="sync-loading">正在同步仓库进度…</div>
          <template v-else-if="github?.configured">
            <a class="repo-card">
              <span>REPOSITORY - CLOSE SOURCE</span><b>{{ github.repository?.name }}</b><p>{{ github.repository?.description || 'AetherAC development repository' }}</p>
            </a>
            <div class="github-metrics">
              <div><strong>{{ github.totals?.completion }}%</strong><span>ISSUE COMPLETION</span></div>
              <div><strong>{{ github.totals?.openIssues }}</strong><span>OPEN ISSUES</span></div>
              <div><strong>{{ github.totals?.milestones }}</strong><span>MILESTONES</span></div>
            </div>
            <div class="issue-list">
              <span class="list-label">RECENT ACTIVITY</span>
              <a v-for="issue in github.recentIssues" :key="issue.number" :href="issue.url" target="_blank" rel="noreferrer">
                <CheckCircle2 v-if="issue.state === 'closed'" :size="15" /><CircleDot v-else :size="15" />
                <span><b>#{{ issue.number }} {{ issue.title }}</b><small>{{ formatDate(issue.updatedAt) }}</small></span>
                <ArrowUpRight :size="13" />
              </a>
            </div>
          </template>
          <div v-else class="sync-empty">
            <Github :size="28" />
            <h3>等待 GitHub 连接</h3>
            <p>{{ github?.message }}</p>
            <code>GITHUB_REPOSITORY<br>GITHUB_TOKEN</code>
          </div>
        </aside>
      </section>
    </main>
    <SiteFooter />
  </div>
</template>
