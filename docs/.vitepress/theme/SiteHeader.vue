<script setup lang="ts">
import { ref, watch } from 'vue'
import { Menu, X, ArrowUpRight, Bell, Headset, ShieldCheck } from 'lucide-vue-next'
import { useAuth } from './auth'
import { badgeText, useInboxBadge } from './inbox'

const auth = useAuth()
const badge = useInboxBadge()
const open = ref(false)

// 角标在顶栏上，所以拉它的地方也在顶栏上：每一页都有这个组件，而 §9.6 的待处理是要在任何一页上都
// 提醒到人的。状态在模块级（见 inbox.ts），所以切页不会各拉一份，收件箱里点掉一条这里立刻就少一个。
watch(() => auth.ready.value, ready => {
  if (ready && auth.user.value) void badge.refreshBadge()
}, { immediate: true })

const links = [
  { label: '能力', href: '/#features' },
  { label: '检测', href: '/#checks' },
  { label: '兼容性', href: '/#compatibility' },
  { label: '开发进度', href: '/progress' },
  { label: 'Blog', href: '/blog' },
  { label: 'News', href: '/news' },
  { label: '购买', href: '/buy' }
]
</script>

<template>
  <header class="global-header">
    <nav class="nav-container" aria-label="主导航">
      <a class="site-brand" href="/" aria-label="AetherAC 首页">
        <span class="brand-glyph"><ShieldCheck :size="21" /></span>
        <span>Aether<strong>AC</strong></span>
      </a>
      <div class="desktop-links">
        <a v-for="link in links" :key="link.href" :href="link.href">{{ link.label }}</a>
      </div>
      <!-- 客服的入口只对客服显示。藏起来不是权限——权限在 RLS 上，这里只是别让买家看到一个点进去被拒的链接。 -->
      <a v-if="auth.isStaff.value" class="nav-contact nav-cs" href="/cs">客服台 <Headset :size="14" /></a>
      <!-- 未读和待处理是两个数：待处理即使读过也还挡着（§9.6），所以它有自己的颜色，而不是加进未读里。 -->
      <a v-if="auth.user.value" class="nav-inbox" href="/inbox" aria-label="站内信">
        <Bell :size="17" />
        <em v-if="badge.pending.value" class="nav-inbox-pending">{{ badgeText(badge.pending.value) }}</em>
        <em v-else-if="badge.unread.value" class="nav-inbox-unread">{{ badgeText(badge.unread.value) }}</em>
      </a>
      <a class="nav-contact" href="/me">我的账户 <ArrowUpRight :size="14" /></a>
      <button class="nav-toggle" :aria-expanded="open" aria-label="切换菜单" @click="open = !open">
        <X v-if="open" :size="21" /><Menu v-else :size="21" />
      </button>
    </nav>
    <div v-if="open" class="mobile-links">
      <a v-for="link in links" :key="link.href" :href="link.href" @click="open = false">{{ link.label }}</a>
      <a v-if="auth.isStaff.value" href="/cs">客服工作台</a>
      <a v-if="auth.user.value" href="/inbox">
        站内信<span v-if="badge.unread.value || badge.pending.value">（{{ badgeText(badge.unread.value + badge.pending.value) }}）</span>
      </a>
      <a href="/me">我的账户</a>
    </div>
  </header>
</template>
