<script setup lang="ts">
/**
 * 全站布局。存在的唯一理由是把客服挂件挂到每一页上。
 *
 * 为什么不能用 DefaultTheme 的插槽：本站每个 .md 都写了 layout: false，那时默认主题只渲染
 * <Content/>，layout-bottom 之类的插槽一个都不会出现。所以挂件放在 DefaultTheme.Layout 的
 * 兄弟位置——它是 position: fixed 的，在布局盒子外面反而更干净。
 */
import DefaultTheme from 'vitepress/theme'
import CsWidget from './CsWidget.vue'
</script>

<template>
<DefaultTheme.Layout />
<CsWidget />
</template>
