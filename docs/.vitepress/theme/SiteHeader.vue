<script setup lang="ts">
import { ref } from 'vue'
import { Menu, X, ArrowUpRight, ShieldCheck } from 'lucide-vue-next'

const open = ref(false)
const links = [
  { label: '能力', href: '/#features' },
  { label: '检测', href: '/#checks' },
  { label: '兼容性', href: '/#compatibility' },
  { label: '开发进度', href: '/progress' },
  { label: 'Blog', href: '/blog' },
  { label: 'News', href: '/news' }
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
      <a class="nav-contact" href="mailto:contact@aetherac.abnt.it">联系团队 <ArrowUpRight :size="14" /></a>
      <button class="nav-toggle" :aria-expanded="open" aria-label="切换菜单" @click="open = !open">
        <X v-if="open" :size="21" /><Menu v-else :size="21" />
      </button>
    </nav>
    <div v-if="open" class="mobile-links">
      <a v-for="link in links" :key="link.href" :href="link.href" @click="open = false">{{ link.label }}</a>
      <a href="mailto:contact@aetherac.abnt.it">contact@abnt.it</a>
    </div>
  </header>
</template>
