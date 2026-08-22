import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'AetherAC',
  description: '为 Minecraft Java 与 Bedrock 网络打造的证据驱动型服务端反作弊系统。',
  cleanUrls: true,
  sitemap: {
    hostname: 'https://aetherac.abnt.it'
  },
  head: [
    ['meta', { name: 'theme-color', content: '#050807' }],
    ['meta', { name: 'color-scheme', content: 'dark' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'AetherAC' }],
    ['meta', { property: 'og:url', content: 'https://aetherac.abnt.it/' }],
    ['meta', { property: 'og:title', content: 'AetherAC — 证据驱动型服务端反作弊' }],
    ['meta', { property: 'og:description', content: '看见行为，而非客户端。面向 Minecraft Java 与 Bedrock 网络。' }],
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }]
  ],
  themeConfig: {
    search: {
      provider: 'local'
    }
  }
})
