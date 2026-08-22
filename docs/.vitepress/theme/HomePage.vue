<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  Activity, ArrowRight, Blocks, Box, Check, ChevronRight, CircleCheck, Clock3,
  Database, Fingerprint, Gauge, Github, Globe2, Network, Radar, Radio,
  ShieldCheck, Sparkles, Swords, Workflow, Zap
} from 'lucide-vue-next'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'
import { fetchPosts, fetchProgress, formatDate, type ContentPost, type ProgressEntry } from './content'

const posts = ref<ContentPost[]>([])
const progress = ref<ProgressEntry[]>([])
const signalIndex = ref(0)
const signals = [
  { check: 'SimulationMismatch', player: 'N0cturne', delta: '+0.0387', confidence: 98, type: 'IMPOSSIBLE' },
  { check: 'Reach', player: 'glass_walker', delta: '3.84m', confidence: 91, type: 'HIGH CONF.' },
  { check: 'TimerBalance', player: 'bedrock_42', delta: '+6.2t', confidence: 76, type: 'HEURISTIC' }
]
const platforms = ['Paper', 'Purpur', 'Folia', 'Fabric', 'Forge', 'NeoForge', 'Velocity', 'BungeeCord']
const checkGroups = [
  { name: 'Movement', icon: Activity, count: '18+', items: ['Simulation', 'Fly', 'Speed', 'Timer', 'Velocity'] },
  { name: 'Combat', icon: Swords, count: '13+', items: ['Reach', 'Aura', 'Rotation', 'Backtrack', 'Critical'] },
  { name: 'World', icon: Blocks, count: '12+', items: ['Scaffold', 'FastBreak', 'Nuker', 'GhostHand', 'AirPlace'] },
  { name: 'Protocol', icon: Network, count: '15+', items: ['BadPackets', 'Blink', 'Transaction', 'Payload', 'RateLimit'] }
]

onMounted(async () => {
  const [news, roadmap] = await Promise.all([fetchPosts('news'), fetchProgress()])
  posts.value = news.data.slice(0, 3)
  progress.value = roadmap.data
})
</script>

<template>
  <div class="dark-page home-page">
    <SiteHeader />
    <main>
      <section class="home-hero">
        <div class="hero-noise"></div><div class="hero-grid-lines"></div><div class="hero-glow"></div>
        <div class="home-container hero-layout">
          <div class="hero-copy">
            <div class="trust-pill"><i></i> SERVER-SIDE DEFENSE · TECHNICAL PREVIEW</div>
            <h1>服务器知道的，<br><em>才是事实。</em></h1>
            <p>AetherAC 是面向 Minecraft Java 与 Bedrock 网络的证据驱动型服务端反作弊。重建每一次移动、每一段时序，并解释每一个无法成立的行为。</p>
            <div class="hero-actions"><a class="primary-button" href="/progress">查看开发进度 <ArrowRight :size="16" /></a><a class="outline-button" href="#features">探索检测引擎 <ChevronRight :size="16" /></a></div>
            <div class="hero-facts"><span><CircleCheck :size="14" /> 纯服务端</span><span><CircleCheck :size="14" /> Java + Bedrock</span><span><CircleCheck :size="14" /> 1.8.8 — Latest</span></div>
          </div>

          <div class="hero-console">
            <div class="console-chrome"><span><i></i><i></i><i></i></span><b>aether://player-timeline</b><span class="live-dot">LIVE</span></div>
            <div class="console-stage">
              <div class="radar-rings"><i></i><i></i><i></i><span></span></div>
              <div class="player-node"><Fingerprint :size="25" /></div>
              <span class="packet packet-a">#8127341 MOVE</span><span class="packet packet-b">#8127342 ROTATE</span><span class="packet packet-c">#8127343 ATTACK</span>
            </div>
            <div class="console-signal">
              <div class="signal-tabs"><button v-for="(_, index) in signals" :key="index" :class="{ active: signalIndex === index }" @click="signalIndex = index"></button></div>
              <div><span>{{ signals[signalIndex].type }}</span><h3>{{ signals[signalIndex].check }}</h3><p>{{ signals[signalIndex].player }} · protocol 767</p></div>
              <strong>{{ signals[signalIndex].delta }}</strong>
              <div class="confidence"><span>CONFIDENCE</span><i><b :style="{ width: `${signals[signalIndex].confidence}%` }"></b></i><strong>{{ signals[signalIndex].confidence }}%</strong></div>
            </div>
          </div>
        </div>
        <div class="hero-status home-container"><span><Radio :size="13" /> SYSTEMS IN DEVELOPMENT</span><div><span>PROTOCOL</span><span>SIMULATION</span><span>EVIDENCE</span><span>ENFORCEMENT</span></div></div>
      </section>

      <section id="features" class="home-section feature-section home-container">
        <div class="section-intro"><div><span class="section-code">01 / DIFFERENCE</span><h2>不是更多阈值，<br>而是更完整的上下文。</h2></div><p>AetherAC 不通过客户端名称、Jar 哈希或模块字符串判断作弊。它验证服务端能够观察到的物理、协议与状态矛盾。</p></div>
        <div class="home-feature-grid">
          <article><div class="feature-icon"><Radar /></div><span>PLAYER-SPECIFIC</span><h3>逐玩家预测引擎</h3><p>根据协议版本、碰撞、属性、效果与玩家所见世界生成合法候选状态集合。</p><small>01</small></article>
          <article class="accent-card"><div class="feature-icon"><Clock3 /></div><span>MONOTONIC TIMELINE</span><h3>严格有序时间线</h3><p>传送、velocity、攻击、切槽与确认包在相同逻辑时间线上复核。</p><small>02</small></article>
          <article><div class="feature-icon"><Sparkles /></div><span>EXPLAINABLE EVIDENCE</span><h3>管理员可读证据</h3><p>保存预期包络、实际偏差、网络状态、检查版本和 ServerReplay 标记。</p><small>03</small></article>
          <article><div class="feature-icon"><Workflow /></div><span>CONTEXTUAL RISK</span><h3>独立证据聚合</h3><p>同源检查不重复计分；镜像不完整或场景未知时自动降级到记录模式。</p><small>04</small></article>
        </div>
      </section>

      <section id="checks" class="checks-section">
        <div class="home-container">
          <div class="section-intro light"><div><span class="section-code">02 / DETECTIONS</span><h2>覆盖行为类别，<br><em>不追逐客户端名单。</em></h2></div><p>确定性检查处理不可能事件；统计模型只形成弱证据。每一类检查都拥有独立版本、兼容范围和动作策略。</p></div>
          <div class="check-grid">
            <article v-for="group in checkGroups" :key="group.name"><div class="check-head"><component :is="group.icon" :size="22" /><span>{{ group.count }}</span></div><h3>{{ group.name }}</h3><ul><li v-for="item in group.items" :key="item"><Check :size="13" />{{ item }}</li></ul></article>
          </div>
          <div class="evidence-strip"><div><ShieldCheck :size="24" /><span>IMPOSSIBLE</span><p>协议或物理上不可能</p></div><i></i><div><Gauge :size="24" /><span>HIGH CONFIDENCE</span><p>独立状态矛盾共同成立</p></div><i></i><div><Activity :size="24" /><span>HEURISTIC</span><p>只记录和告警的统计异常</p></div></div>
        </div>
      </section>

      <section id="compatibility" class="home-section compatibility-section home-container">
        <div class="section-intro"><div><span class="section-code">03 / COMPATIBILITY</span><h2>单服或全网，<br>使用同一套事实。</h2></div><p>后端适配器获取世界与玩家状态，代理组件只同步身份、风险和处罚。Java 与 Bedrock 使用各自的移动模型。</p></div>
        <div class="compatibility-map">
          <div class="edition-stack"><span>CLIENT EDITION</span><div><Box :size="21" /><b>Java Edition</b><small>1.8.8 — Latest</small></div><div><Globe2 :size="21" /><b>Bedrock Edition</b><small>Geyser / Floodgate</small></div></div>
          <div class="map-line"><i></i><b></b></div>
          <div class="core-orb"><span></span><ShieldCheck :size="34" /><b>AETHER CORE</b><small>Evidence Pipeline</small></div>
          <div class="map-line reverse"><i></i><b></b></div>
          <div class="platform-stack"><span>SERVER PLATFORM</span><div><b v-for="platform in platforms" :key="platform">{{ platform }}</b></div></div>
        </div>
      </section>

      <section class="performance-section">
        <div class="home-container performance-layout">
          <div><span class="section-code">04 / OPERATIONS</span><h2>热路径必须严格，<br>系统边界必须克制。</h2><p>数据库和磁盘 I/O 不进入游戏 tick。内部异常隔离对应检查，而不是让整个反作弊失效。</p><a href="/progress">查看实时研发路线 <ArrowRight :size="15" /></a></div>
          <div class="metrics"><article><strong>&lt;2<small>ms</small></strong><p>100 名玩家平均 tick 目标</p><Gauge :size="17" /></article><article><strong>&lt;200<small>µs</small></strong><p>数据包热路径 p99</p><Zap :size="17" /></article><article><strong>100<small>%</small></strong><p>轨迹重放确定性</p><CircleCheck :size="17" /></article><article><strong>&lt;8<small>MiB</small></strong><p>单玩家世界镜像目标</p><Database :size="17" /></article></div>
        </div>
      </section>

      <section class="home-section progress-preview home-container">
        <div class="section-intro"><div><span class="section-code">05 / PUBLIC BUILD</span><h2>进度不是营销数字，<br>而是可追踪的工作。</h2></div><a class="text-action" href="/progress"><Github :size="16" /> 打开开发进度 <ArrowRight :size="15" /></a></div>
        <div class="mini-roadmap"><article v-for="stage in progress.slice(0,4)" :key="stage.id"><div><span>STAGE {{ stage.stage }}</span><strong>{{ stage.percent }}%</strong></div><h3>{{ stage.title }}</h3><p>{{ stage.summary }}</p><i><b :style="{ width: `${stage.percent}%` }"></b></i></article></div>
      </section>

      <section class="news-section home-container">
        <div class="section-intro"><div><span class="section-code">06 / TRANSMISSIONS</span><h2>最新项目动态。</h2></div><a class="text-action" href="/news">浏览全部 News <ArrowRight :size="15" /></a></div>
        <div class="home-news-grid"><a v-for="(post,index) in posts" :key="post.id" :href="`/news?post=${post.slug}`"><div><span>0{{ index + 1 }}</span><Radio :size="17" /></div><time>{{ formatDate(post.published_at) }}</time><h3>{{ post.title }}</h3><p>{{ post.summary }}</p><b>READ TRANSMISSION <ArrowRight :size="13" /></b></a></div>
      </section>

      <section class="home-cta home-container"><div class="cta-lines"></div><ShieldCheck :size="38" /><span>TECHNICAL PREVIEW</span><h2>让每一个判断，<br>都经得起复核。</h2><p>参与 AetherAC 的性能、兼容性与证据工作流验证。</p><a class="primary-button" href="mailto:contact@abnt.it">联系 contact@abnt.it <ArrowRight :size="16" /></a></section>
    </main>
    <SiteFooter />
  </div>
</template>
