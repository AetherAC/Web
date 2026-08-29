<script setup lang="ts">
import { ref } from 'vue'
import { Menu, X, ArrowUpRight, Headset, ShieldCheck } from 'lucide-vue-next'
import { useAuth } from './auth'

const auth = useAuth()
const open = ref(false)
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
      <a class="nav-contact" href="/me">我的账户 <ArrowUpRight :size="14" /></a>
      <button class="nav-toggle" :aria-expanded="open" aria-label="切换菜单" @click="open = !open">
        <X v-if="open" :size="21" /><Menu v-else :size="21" />
      </button>
    </nav>
    <div v-if="open" class="mobile-links">
      <a v-for="link in links" :key="link.href" :href="link.href" @click="open = false">{{ link.label }}</a>
      <a v-if="auth.isStaff.value" href="/cs">客服工作台</a>
      <a href="/me">我的账户</a>
    </div>
  </header>
</template>
