/**
 * §6 的用户组定义。浏览器和 Serverless 函数都从这里读，所以只有一份。
 *
 * 第二份（也是最后一份）在 supabase/schema.sql 的 private.group_rank() 里，那份用 SQL 写、管 RLS，
 * 没法从 JS 引用。tests/api-smoke.mjs 会把这个文件和那段 SQL 对着断言，两边排名不一致就构建失败——
 * 不一致的后果是「界面显示能做但接口拒绝」，或者反过来，后者是个安全洞。
 *
 * 纯 .mjs 而不是 .ts：api/ 下的函数在 Node 里直接跑，测试也是；auth.ts 那边由 Vite 处理，两种环境
 * 都能吃。放在 shared/ 而不是 api/_lib/ 下，是因为 api/ 目录里的每个文件都会被 Vercel 当成一个路由。
 */

/** §6 的优先级列。客服工单分配顺序，也是订单/退款可见性的阈值。 */
export const GROUP_RANK = { admin: 999, cs: 888, postsale: 777, presale: 777, coworker: 555, read: 111, default: 0 }

/** 后台用户组下拉框的顺序，从低到高。 */
export const GROUP_ORDER = ['default', 'read', 'coworker', 'presale', 'postsale', 'cs', 'admin']

export const GROUP_LABEL = {
  admin: '管理员', cs: '客服（售前+售后）', postsale: '售后客服', presale: '售前客服',
  coworker: '文案', read: '只读成员', default: '普通用户'
}

/** 有名字的阈值，这样以后改数字时意图还在。 */
export const RANK = {
  /** 全部权限：批退款、改订单、支付平台、环境变量。§6 的 999。 */
  ADMIN: 999,
  /** 能接工单的人：presale / postsale / cs / admin。§2.2。 */
  STAFF: 777,
  /** 组织成员：能看草稿、停用的仓库，以及 §12.2 的全部订单。 */
  MEMBER: 111
}

/**
 * 编辑权限。**不是** rank 阈值，是一份名单。
 *
 * §6 的优先级排的是客服分配顺序：presale 是 777，coworker 是 555。如果把「能发文章」写成 rank >= 555，
 * 售前客服就顺带获得了改站点内容的权限，而 §2 从没给过这个权限。这两件事必须是两条独立的判断。
 */
export const EDITOR_GROUPS = ['coworker', 'admin']

/** 未知组一律 0：将来往枚举里加了组但忘了在这里排名，那个组无权，而不是意外获得权限。 */
export const rankOf = group => GROUP_RANK[group ?? 'default'] ?? 0
export const isEditor = group => EDITOR_GROUPS.includes(group)
