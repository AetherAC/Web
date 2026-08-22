export type ContentKind = 'blog' | 'news'

export interface ContentPost {
  id: string
  kind: ContentKind
  slug: string
  title: string
  summary: string
  body: string
  cover_url?: string | null
  tags: string[]
  published_at: string
  updated_at?: string
  featured?: boolean
}

export interface ProgressEntry {
  id: string
  stage: string
  title: string
  summary: string
  percent: number
  status: 'planned' | 'active' | 'complete' | 'paused'
  sort_order: number
  updated_at: string
}

const fallbackPosts: ContentPost[] = [
  {
    id: 'local-architecture',
    kind: 'blog',
    slug: 'why-evidence-first',
    title: '为什么 AetherAC 从证据链开始设计',
    summary: '从一个模糊的 VL 数字，走向可复核、可重放、能够解释处罚原因的完整证据模型。',
    body: 'AetherAC 将数据包时序、预测状态、网络质量与检测版本一同保存。管理员看到的不再只是检查名称，而是一条能够复核的技术事实链。',
    tags: ['Architecture', 'Evidence'],
    published_at: '2026-08-22T08:00:00+08:00',
    featured: true
  },
  {
    id: 'local-bedrock',
    kind: 'blog',
    slug: 'bedrock-is-not-an-exemption',
    title: 'Bedrock 不应该是一条豁免规则',
    summary: 'Java 与 Bedrock 使用不同预测器，但必须汇入相同严格的服务器事实。',
    body: '触屏、手柄与键鼠输入需要不同统计模型；碰撞、非法位移和服务端最终交互状态仍然可以被严格验证。',
    tags: ['Bedrock', 'Geyser'],
    published_at: '2026-08-18T08:00:00+08:00'
  },
  {
    id: 'local-rename',
    kind: 'news',
    slug: 'introducing-aetherac',
    title: 'AetherAC：新的名称，同一条技术路线',
    summary: '项目正式由 AegisAC 更名为 AetherAC，站点、包名、命令空间与后续发布将统一使用新品牌。',
    body: '更名不会改变纯服务端、行为检测、证据驱动和 Java/Bedrock 双模型的核心方向。',
    tags: ['Announcement'],
    published_at: '2026-08-22T12:00:00+08:00',
    featured: true
  },
  {
    id: 'local-baseline',
    kind: 'news',
    slug: 'baseline-1211',
    title: '首个研发基线锁定 Java 1.21.1',
    summary: '第一阶段将集中完成 Paper/Purpur 协议、时间线、重放、SQLite 与证据告警闭环。',
    body: '跨版本支持会在重放确定性和合法轨迹基线通过后依次扩展，而不是用未知版本路径直接处罚。',
    tags: ['Development'],
    published_at: '2026-08-16T08:00:00+08:00'
  }
]

export const fallbackProgress: ProgressEntry[] = [
  { id: 'p0', stage: '00', title: '语料与行为规范', summary: '样本登记、许可证来源、隔离测试与数据包轨迹。', percent: 72, status: 'active', sort_order: 0, updated_at: '2026-08-22T12:00:00+08:00' },
  { id: 'p1', stage: '01', title: '协议、时间线与重放', summary: '1.21.1 标准包模型、单玩家时间线、确定性重放。', percent: 18, status: 'active', sort_order: 1, updated_at: '2026-08-22T12:00:00+08:00' },
  { id: 'p2', stage: '02', title: 'Java Movement', summary: '世界镜像、碰撞、移动预测与安全 setback。', percent: 4, status: 'planned', sort_order: 2, updated_at: '2026-08-22T12:00:00+08:00' },
  { id: 'p3', stage: '03', title: 'Combat / World / Inventory', summary: 'Reach、Aura、交互与库存状态机。', percent: 0, status: 'planned', sort_order: 3, updated_at: '2026-08-22T12:00:00+08:00' },
  { id: 'p4', stage: '04—06', title: '跨版本、多平台与 Bedrock', summary: '版本带、Folia/Fabric/Forge、代理集群及独立 Bedrock 模型。', percent: 0, status: 'planned', sort_order: 4, updated_at: '2026-08-22T12:00:00+08:00' }
]

const supabaseConfig = () => ({
  url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  key: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
})

async function supabaseFetch<T>(table: string, query: string): Promise<T[] | null> {
  const { url, key } = supabaseConfig()
  if (!url || !key) return null
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  })
  if (!response.ok) throw new Error(`CMS request failed: ${response.status}`)
  return response.json()
}

export async function fetchPosts(kind: ContentKind): Promise<{ data: ContentPost[]; source: 'cms' | 'fallback' }> {
  try {
    const data = await supabaseFetch<ContentPost>('posts', `kind=eq.${kind}&status=eq.published&order=published_at.desc`)
    if (data?.length) return { data, source: 'cms' }
  } catch (error) {
    console.warn('[AetherAC CMS]', error)
  }
  return { data: fallbackPosts.filter(post => post.kind === kind), source: 'fallback' }
}

export async function fetchProgress(): Promise<{ data: ProgressEntry[]; source: 'cms' | 'fallback' }> {
  try {
    const data = await supabaseFetch<ProgressEntry>('progress_entries', 'order=sort_order.asc')
    if (data?.length) return { data, source: 'cms' }
  } catch (error) {
    console.warn('[AetherAC CMS]', error)
  }
  return { data: fallbackProgress, source: 'fallback' }
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value))
}
