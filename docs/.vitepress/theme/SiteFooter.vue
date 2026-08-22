<script setup lang="ts">
import { ShieldCheck, ArrowUpRight } from 'lucide-vue-next'
</script>

<template>
  <footer class="global-footer">
    <div class="footer-main">
      <div>
        <a class="site-brand" href="/"><span class="brand-glyph"><ShieldCheck :size="21" /></span><span>Aether<strong>AC</strong></span></a>
        <p>服务器可观察行为的确定性防线。</p>
      </div>
      <div class="footer-nav">
        <a href="/progress">开发进度</a><a href="/blog">Blog</a><a href="/news">News</a><a href="/studio">内容管理</a>
      </div>
      <a class="footer-email" href="mailto:contact@aetherac.abnt.it">contact@aetherac.abnt.it <ArrowUpRight :size="15" /></a>
    </div>
    <div class="footer-bottom"><span>© 2026 AetherAC</span><span>Not affiliated with Mojang Studios or Microsoft.</span></div>
  </footer>
</template>
