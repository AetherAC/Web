import { bodyOf, RANK, rankOf, requireUser, send, serviceClient } from './_lib/server.mjs'

/**
 * §6 GitHub 团队 → 用户组映射的执行端。
 *
 * 映射表在 public.github_team_map 里，不在这里硬编码：团队 slug 是 §6 里唯一无法从代码验证的部分，
 * 放进表就能改错不用发版。
 *
 * 三个调用方式：
 *   GET                     — 当前登录用户自己重新同步（登录后前端自动打一次）
 *   POST {login}            — 管理员按 GitHub 用户名同步某人
 *   POST {all:true}         — 管理员全量同步（按 user_profiles.github_login 逐个查）
 *
 * 用 org token 而不是用户自己的 OAuth token：读团队成员要 read:org，而站点的 OAuth scope 里没有它，
 * 加进去会让每个买家在授权页上看到「读取组织成员」——买家不需要给出这个权限。
 */

const ORG = process.env.GITHUB_ORG || 'AetherAC'
const TOKEN_HINT = '在 Vercel 中配置 GITHUB_ORG_TOKEN（需要 read:org）后启用 GitHub 团队同步。'

const gh = async (path, token) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AetherAC-Group-Sync'
    }
  })
  // 404 在这里是正常答案，不是错误：不在团队里就是 404。403 才是 token scope 不够。
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${(await response.text()).slice(0, 200)}`)
  return response.json()
}

/** 取映射表，顺带把 slug 规范化成小写——GitHub 的 slug 本来就是小写，但表是人填的。 */
async function teamMap(db) {
  const { data, error } = await db.from('github_team_map').select('team_slug,group_name')
  if (error) throw new Error(error.message)
  return (data ?? []).map(row => ({ slug: String(row.team_slug).trim().toLowerCase().split('/').pop(), group: row.group_name }))
}

/**
 * 决定一个 GitHub 用户该进哪个组。
 *
 * 先按 §6 的优先级取最高，再看要不要升 cs。顺序很重要：cs 是 777 这一档内部的升级
 * （presale + postsale 都在 → cs），不是一条能盖过 admin 的规则。反过来写的话，一个既在 devs 又在两个
 * 客服团队里的人会从 admin 被降成 cs。
 *
 * 一个组都没命中 → 由调用方决定（在组织里给 read，不在就不动）。
 */
export function resolveGroup(matchedGroups) {
  const set = new Set(matchedGroups)
  let best = null
  for (const group of set) if (!best || rankOf(group) > rankOf(best)) best = group
  if (!best) return null
  // 只有当最高档正好落在单一客服组上时才升 cs——admin 在上面，不受影响。
  if ((best === 'presale' || best === 'postsale') && set.has('presale') && set.has('postsale')) return 'cs'
  return best
}

/** 查一个人所有团队的成员身份，返回命中的组名。并发打，团队数是个位数。 */
async function groupsFor(login, map, token) {
  const results = await Promise.all(map.map(async ({ slug, group }) => {
    const membership = await gh(`/orgs/${encodeURIComponent(ORG)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(login)}`, token)
    // pending 是「邀请了还没接受」——还没进团队，不给权限。
    return membership?.state === 'active' ? group : null
  }))
  return results.filter(Boolean)
}

/** 查他是不是组织成员。不是成员而映射又全空时，要能区分「没进组织」和「进了但没团队」。 */
const inOrg = async (login, token) => {
  const membership = await gh(`/orgs/${encodeURIComponent(ORG)}/memberships/${encodeURIComponent(login)}`, token)
  return membership?.state === 'active'
}

async function syncOne(db, { userId, login }, map, token) {
  const matched = await groupsFor(login, map, token)
  let group = resolveGroup(matched)
  if (!group) {
    // 团队一个没命中：在组织里 → read（§6 其他成员），不在组织里 → 不改，让他保持原样。
    if (!await inOrg(login, token)) return { login, user_id: userId, skipped: 'not-an-org-member' }
    group = 'read'
  }
  const patch = { group_name: group, github_login: login, github_synced_at: new Date().toISOString() }
  const query = userId
    ? db.from('user_profiles').update(patch).eq('user_id', userId)
    : db.from('user_profiles').update(patch).eq('github_login', login)
  const { data, error } = await query.select('user_id,group_name')
  if (error) throw new Error(error.message)
  if (!data?.length) return { login, user_id: userId, skipped: 'no-matching-profile' }
  return { login, user_id: data[0].user_id, group_name: group, teams: matched }
}

/** 从 auth 用户的 metadata 里挖 GitHub 用户名。GitHub OAuth 存在 user_name，别的 provider 没有。 */
export const loginOf = user =>
  user?.user_metadata?.user_name || user?.user_metadata?.preferred_username || null

export default async function handler(req, res) {
  const token = process.env.GITHUB_ORG_TOKEN
  // 没配 token 时用 200 回 configured:false，跟 github-progress.mjs 一致：前端登录后会无条件打这个
  // 接口，回 5xx 会在每个用户的控制台里刷红，而「没配」不是错误。
  if (!token) return send(res, 200, { configured: false, message: TOKEN_HINT })

  try {
    if (req.method === 'GET') {
      // 自助同步：只认当前 session 的身份，不接受参数，所以任何登录用户都能打。
      const auth = await requireUser(req, res)
      if (!auth) return
      const login = loginOf(auth.user)
      if (!login) return send(res, 200, { configured: true, synced: false, message: '当前账号不是通过 GitHub 登录的，无法按团队同步权限。' })
      const result = await syncOne(auth.db, { userId: auth.user.id, login }, await teamMap(auth.db), token)
      return send(res, 200, { configured: true, synced: !result.skipped, ...result })
    }

    if (req.method === 'POST') {
      const auth = await requireUser(req, res, RANK.ADMIN)
      if (!auth) return
      const body = await bodyOf(req)
      const map = await teamMap(auth.db)

      if (body.all === true) {
        const db = serviceClient()
        // 全量同步走 auth 用户表，因为 github_login 是这个端点自己写的——第一次跑的时候它还是空的。
        const targets = []
        for (let page = 1; page <= 50; page += 1) {
          const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 })
          if (error) throw new Error(error.message)
          for (const user of data.users) {
            const login = loginOf(user)
            if (login) targets.push({ userId: user.id, login })
          }
          if (data.users.length < 200) break
        }
        const results = []
        // 串行。GitHub 的次级速率限制盯的是并发写，团队数 × 用户数很容易撞上，而这个接口不赶时间。
        for (const target of targets) {
          try { results.push(await syncOne(auth.db, target, map, token)) }
          catch (error) { results.push({ login: target.login, user_id: target.userId, error: error.message }) }
        }
        const changed = results.filter(row => row.group_name).length
        return send(res, 200, { configured: true, scanned: targets.length, changed, results })
      }

      const login = String(body.login ?? '').trim()
      if (!login) return send(res, 400, { error: '需要 login（GitHub 用户名）或 all:true' })
      const result = await syncOne(auth.db, { userId: body.user_id || null, login }, map, token)
      return send(res, 200, { configured: true, synced: !result.skipped, ...result })
    }

    return send(res, 405, { error: 'Method not allowed' })
  } catch (error) {
    console.error('[sync-github-groups]', error)
    const scope = /\b403\b/.test(error.message)
    return send(res, 502, { configured: true, error: scope ? `GitHub 拒绝了请求，GITHUB_ORG_TOKEN 可能缺少 read:org：${error.message}` : error.message })
  }
}
