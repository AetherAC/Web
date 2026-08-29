create extension if not exists pgcrypto;
create schema if not exists private;
drop table if exists public.site_admins cascade;

-- Seven groups, mapped from GitHub teams by api/sync-github-groups.mjs. The three customer-service
-- groups are added with ALTER for databases created before they existed.
--
-- Nothing below may write these names as enum literals. `alter type ... add value` is allowed inside a
-- transaction since PG 12, but *using* the new value in the same transaction is not, and this file is
-- executed as one implicit transaction. So every permission test goes through private.group_rank(),
-- which compares `g::text` and therefore never mentions a literal of the type it switches on.
do $$ begin create type public.user_group as enum ('default','read','coworker','presale','postsale','cs','admin'); exception when duplicate_object then null; end $$;
alter type public.user_group add value if not exists 'presale';
alter type public.user_group add value if not exists 'postsale';
alter type public.user_group add value if not exists 'cs';
do $$ begin create type public.content_kind as enum ('blog','news'); exception when duplicate_object then null; end $$;
do $$ begin create type public.content_status as enum ('draft','published'); exception when duplicate_object then null; end $$;
do $$ begin create type public.progress_status as enum ('planned','active','complete','paused'); exception when duplicate_object then null; end $$;
do $$ begin create type public.order_status as enum ('pending','paid','failed','cancelled','refunded','refund_pending'); exception when duplicate_object then null; end $$;
do $$ begin create type public.refund_status as enum ('submitted','reviewing','approved','rejected','completed'); exception when duplicate_object then null; end $$;

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null default '',
  group_name public.user_group not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_profiles add column if not exists email text;
alter table public.user_profiles add column if not exists display_name text not null default '';
alter table public.user_profiles add column if not exists github_login text;
alter table public.user_profiles add column if not exists github_synced_at timestamptz;
create index if not exists user_profiles_github_login_idx on public.user_profiles(lower(github_login));

-- Which GitHub team grants which group. A table rather than a constant in the sync endpoint so the
-- mapping can be corrected without a deploy — team slugs are the one part of §6 nobody can verify from
-- here. group_name is text, not public.user_group, for the transaction reason given above the enum:
-- seeding 'cs' as an enum literal in this file would fail on a database that just gained the value.
create table if not exists public.github_team_map (
  team_slug text primary key, group_name text not null check (group_name in ('read','coworker','presale','postsale','cs','admin')),
  note text not null default '', updated_at timestamptz not null default now()
);
insert into public.github_team_map(team_slug,group_name,note) values
  ('devs','admin','§6 @AetherAC/devs → admin（优先级 999）'),
  ('testers','admin','§6 @AetherAC/testers → admin（优先级 999，已确认有意：测试人员可批退款）'),
  ('pre-sales','presale','§6 customer-service/pre-sales → presale（777）。子团队在 GitHub API 里用自己的 slug，不是路径'),
  ('post-sales','postsale','§6 customer-service/post-sales → postsale（777）'),
  ('copywriter','coworker','§6 @AetherAC/copywriter → coworker（555）')
on conflict(team_slug) do update set group_name=excluded.group_name,note=excluded.note;
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(), kind public.content_kind not null default 'news',
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'), title text not null,
  summary text not null, body text not null, cover_url text, tags text[] not null default '{}',
  status public.content_status not null default 'draft', featured boolean not null default false,
  published_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.progress_entries (
  id uuid primary key default gen_random_uuid(), stage text not null, title text not null, summary text not null,
  percent integer not null default 0 check (percent between 0 and 100), status public.progress_status not null default 'planned',
  sort_order integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.repositories (
  id uuid primary key default gen_random_uuid(), name text not null unique check (name ~ '^[^/]+/[^/]+$'),
  label text not null default '', enabled boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
do $$ begin
  if to_regclass('public.site_settings') is not null
    and not exists(select 1 from information_schema.columns where table_schema='public' and table_name='site_settings' and column_name='key')
  then drop table public.site_settings cascade; end if;
end $$;
create table if not exists public.site_settings (
  key text primary key, value jsonb not null default '{}'::jsonb, description text not null default '',
  updated_at timestamptz not null default now()
);
create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(), sku text not null unique, name text not null, description text not null default '',
  price_minor integer not null check (price_minor >= 0), currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  active boolean not null default true, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.payment_providers (
  id text primary key, display_name text not null, enabled boolean not null default false, sort_order integer not null default 0,
  public_config jsonb not null default '{}'::jsonb, secret_env_names text[] not null default '{}',
  instructions text not null default '', updated_at timestamptz not null default now()
);
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete restrict,
  artifact_id uuid not null references public.artifacts(id) on delete restrict, sku text not null, quantity integer not null default 1 check (quantity > 0),
  amount_minor integer not null check (amount_minor >= 0), currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider text not null references public.payment_providers(id), provider_order_id text, checkout_url text,
  status public.order_status not null default 'pending', paid_at timestamptz, provider_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists orders_provider_reference on public.orders(provider, provider_order_id) where provider_order_id is not null;
create index if not exists orders_user_id_idx on public.orders(user_id);
create index if not exists orders_artifact_id_idx on public.orders(artifact_id);
-- At most one pending order per account. api/checkout.mjs checks first so the buyer gets a sentence
-- instead of an error code, but only this index holds when two checkout requests race: both would
-- read zero pending rows and both would insert. The cap is what makes an abandoned checkout the
-- buyer's problem to clear (api/cancel-order.mjs) rather than a growing pile of rows that all look live.
--
-- Pre-existing data has to be reconciled before the index can be created, or a re-run of this file
-- fails on the first account that already has two. Older pending rows are abandoned checkouts by
-- definition -- nothing was ever paid, since a payment moves the row to `paid` -- so the newest is
-- kept and the rest are cancelled. The id tiebreak keeps it deterministic when timestamps collide.
update public.orders set status='cancelled', checkout_url=null where id in (
  select id from (
    select id, row_number() over (partition by user_id order by created_at desc, id desc) as rank
    from public.orders where status='pending'
  ) ranked where rank > 1
);
create unique index if not exists one_pending_order_per_user on public.orders(user_id) where status='pending';
create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict, reason_code text not null, reason_detail text not null,
  evidence_paths text[] not null default '{}', status public.refund_status not null default 'submitted',
  admin_note text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists one_refund_per_order on public.refund_requests(order_id);
create index if not exists refund_requests_user_id_idx on public.refund_requests(user_id);
create table if not exists public.installation_snapshots (
  id bigint generated always as identity primary key, captured_at timestamptz not null default now(),
  installed_hwid bigint not null default 0, running_hwid bigint not null default 0, source text not null default 'sentry'
);
-- Sentry was the original producer and is no longer one; see the comment on telemetry_installs.
alter table public.installation_snapshots alter column source set default 'heartbeat';

-- Telemetry from installed copies of the anticheat: one row per install, upserted on hwid. A sample
-- states an install's current condition rather than recording an event, so this table grows with the
-- number of installs and not with how long they run. 装机量 is count(*); 运行量 is the rows whose
-- last_seen falls inside the running window.
--
-- Those two counts cannot come from Sentry, which is why they live here. The token issued for this
-- project carries only project:releases, so the events API answers 403 — but the deeper problem
-- survives fixing that: count_unique(hwid) over the errors dataset counts only the installs that
-- failed, so a server running cleanly would be invisible and 装机量 would report the crash rate
-- instead of the install base. Sending heartbeats as Sentry events to make them visible would cost
-- ~8,640 events per install per month at five-minute intervals, against a free plan's monthly error
-- quota (5,000 at the time of writing) — one install would exhaust it. Errors, crashes and logs do go
-- to Sentry: that is what it is for, and the DSN alone is enough to send them.
--
-- hwid is a salted SHA-256 over stable machine facts, never a raw machine identifier. The check
-- constraint pins that one canonical form so a client that regressed to sending something
-- identifiable fails loudly here instead of quietly filling the column with it.
create table if not exists public.telemetry_installs (
  hwid text primary key check (hwid ~ '^[0-9a-f]{64}$'),
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(),
  samples bigint not null default 0,
  mcver text not null default '', loader text not null default '', modver text not null default '',
  licensestatus text not null default 'unknown', licensecode text, retry_license_after timestamptz,
  os text not null default '', osver text not null default '', osarch text not null default '',
  -- Accumulated from per-sample deltas. A client that restarts loses its own tallies, so it reports
  -- what happened since its last sample and the total is kept here, where a restart cannot reset it.
  errors bigint not null default 0, crashes bigint not null default 0, warns bigint not null default 0
);
create index if not exists telemetry_installs_last_seen_idx on public.telemetry_installs(last_seen desc);

-- §10 的退款审批状态机。原来的 refund_status 枚举只有 submitted/reviewing/approved/rejected/completed，
-- §10.4 要的是 待审批→已批准/已拒绝/已转交→执行中→已完成/失败。这里把列换成 text + check，而不是给枚举
-- 加值：加值本身在事务里合法，但同一个事务里再用这个新值就不合法，而本文件整体是一个事务（见文件开头
-- 枚举那段注释）。换成 text 之后这一类问题对这张表永久消失，check 约束照样挡住写错的状态名。
-- 旧的 public.refund_status 类型留着不删——删掉救不了任何人，留着也不碍事。
alter table public.refund_requests alter column status drop default;
alter table public.refund_requests alter column status type text using status::text;
update public.refund_requests set status='pending' where status in ('submitted','reviewing');
alter table public.refund_requests alter column status set default 'pending';
alter table public.refund_requests drop constraint if exists refund_requests_status_check;
alter table public.refund_requests add constraint refund_requests_status_check
  check (status in ('pending','approved','rejected','transferred','executing','completed','failed'));
-- §10.2：客服代提退款，所以要记是谁发起的、以什么身份发起的。amount_minor 可改但不得超过实付金额，
-- 上限由下面的触发器保证——check 约束读不到另一张表。
alter table public.refund_requests add column if not exists amount_minor integer;
alter table public.refund_requests add column if not exists currency text;
alter table public.refund_requests add column if not exists initiated_by uuid references auth.users(id) on delete set null;
alter table public.refund_requests add column if not exists initiator_role text not null default 'user';
alter table public.refund_requests add column if not exists decided_by uuid references auth.users(id) on delete set null;
alter table public.refund_requests add column if not exists decided_at timestamptz;
alter table public.refund_requests add column if not exists decision_note text not null default '';
alter table public.refund_requests add column if not exists transferred_to uuid references auth.users(id) on delete set null;
-- §10.5：48 小时未处理要升级并重复提醒。escalated_at 记第一次升级，reminded_at 记最后一次提醒，
-- 用来算下一次该不该再提醒，避免 pg_cron 每跑一次就重复轰炸。
alter table public.refund_requests add column if not exists escalated_at timestamptz;
alter table public.refund_requests add column if not exists reminded_at timestamptz;
alter table public.refund_requests add column if not exists executed_at timestamptz;
alter table public.refund_requests add column if not exists execution_note text not null default '';
alter table public.refund_requests drop constraint if exists refund_requests_initiator_role_check;
alter table public.refund_requests add constraint refund_requests_initiator_role_check
  check (initiator_role in ('user','postsale','cs','admin'));
create index if not exists refund_requests_status_idx on public.refund_requests(status,created_at desc);

-- §12.5 的订单日志，同时也是 §13 状态机留下的痕迹。状态存 text 而不是 order_status，因为 §13 明确要求
-- 记下「PAID → PAID」这种驳回后回到原状态的条目：日志记的是发生过什么，不是当前合法状态集，把它和枚举
-- 解耦之后，将来枚举怎么改都不会让历史条目失效。
create table if not exists public.order_status_log (
  id bigint generated always as identity primary key, order_id uuid not null references public.orders(id) on delete cascade,
  from_status text not null, to_status text not null, actor_id uuid references auth.users(id) on delete set null,
  actor_group text not null default '', source text not null default 'system' check (source in ('user','cs','admin','system','callback')),
  note text not null default '', created_at timestamptz not null default now()
);
create index if not exists order_status_log_order_idx on public.order_status_log(order_id,created_at desc);

-- §10.7 的审批审计流水，可导出。和 order_status_log 分开，因为一次退款审批会产生订单状态之外的动作
-- （改金额、转交、催办），把它们塞进订单日志会让 §12.5 的订单历史被审批噪音淹没。
create table if not exists public.refund_audit_log (
  id bigint generated always as identity primary key, refund_id uuid not null references public.refund_requests(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null, actor_group text not null default '',
  action text not null, from_status text not null default '', to_status text not null default '',
  amount_minor integer, note text not null default '', created_at timestamptz not null default now()
);
create index if not exists refund_audit_log_refund_idx on public.refund_audit_log(refund_id,created_at desc);

-- §1 优惠券。conditions 和 actions 存 jsonb 数组，不拆成列，因为 §1.2/§1.3 的条件类型是开放集合：
-- 金额比较、SKU 的六种匹配方式、历史订单状态+单数，将来还会加。拆成列的话每加一种条件都要改表，而
-- 判定逻辑无论如何都在代码里（shared/coupons.mjs，前后端共用一份，前端算出来的折扣必须和后端一致）。
-- check 约束只保证它们是数组，具体形状由那个模块校验——SQL 里写不出「六种 op 之一」还不失去可扩展性。
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  -- 大写存储。用户输入不分大小写，靠这个约束加上 upper() 的唯一索引保证 abc 和 ABC 不是两张券。
  code text not null check (code = upper(code) and code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  name text not null default '', description text not null default '', enabled boolean not null default true,
  conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions) = 'array'),
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  -- §1.4 的限制。null 表示不限，0 表示一次都不能用——两者不同，所以不能用 0 当「不限」。
  starts_at timestamptz, ends_at timestamptz,
  per_user_limit integer check (per_user_limit is null or per_user_limit >= 0),
  total_limit integer check (total_limit is null or total_limit >= 0),
  allowed_user_ids uuid[] not null default '{}',
  -- 冗余计数，给 total_limit 用。核销时在一个函数里加，不靠 count(*)：并发下两笔单同时读到未满会双花。
  used_count integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create unique index if not exists coupons_code_key on public.coupons(upper(code));
-- 一次核销一行。unique(coupon_id,order_id) 让重复回调不会把同一张券在同一笔单上记两次。
create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  discount_minor integer not null default 0, created_at timestamptz not null default now()
);
create unique index if not exists coupon_redemptions_order_key on public.coupon_redemptions(coupon_id,order_id);
create index if not exists coupon_redemptions_user_idx on public.coupon_redemptions(coupon_id,user_id);

-- §5 订单信息展示。原价、应付、实付是三个不同的数：应付 = 原价经优惠券调整后要付的钱，实付 = 支付平台
-- 实际到账的钱。三者通常相等，不相等的时候正是最需要看清的时候（币种换算、少付、超付），所以分开存。
-- SKU 名称和描述在下单时快照一份：商品改名或改价之后，历史订单要显示当时买的是什么，不是现在的什么。
alter table public.orders add column if not exists list_amount_minor integer;
alter table public.orders add column if not exists discount_minor integer not null default 0;
alter table public.orders add column if not exists paid_amount_minor integer;
alter table public.orders add column if not exists paid_currency text;
alter table public.orders add column if not exists sku_name text not null default '';
alter table public.orders add column if not exists sku_description text not null default '';
alter table public.orders add column if not exists coupon_id uuid references public.coupons(id) on delete set null;
alter table public.orders add column if not exists coupon_code text not null default '';
alter table public.orders add column if not exists payment_reference text not null default '';
-- 历史行的原价就是当时的应付：那时还没有优惠券，没有折扣可言。
update public.orders set list_amount_minor = amount_minor where list_amount_minor is null;
create index if not exists orders_status_created_idx on public.orders(status,created_at desc);
create index if not exists orders_provider_idx on public.orders(provider,created_at desc);
create index if not exists orders_coupon_idx on public.orders(coupon_id) where coupon_id is not null;

-- §2.4 客服在线状态。online 是人工开关，last_heartbeat 是活着的证据，真正的「在线」是两者都成立——
-- 只看开关的话，浏览器被直接杀掉的客服会永远显示在线并继续接单，用户等在一个没人的会话里。
-- 服务的渠道不存在这张表里，它由用户组决定（§2.2），存两份必然有一天不一致。
create table if not exists public.cs_agents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  online boolean not null default false, last_heartbeat timestamptz,
  -- §2.7 的并发上限。null = 用 site_settings 里的全站默认值，这样调整默认值不用逐个改人。
  max_concurrent integer check (max_concurrent is null or max_concurrent >= 0),
  status_note text not null default '', updated_at timestamptz not null default now()
);

-- §2.1/§2.5 会话。channel 决定它出现在哪儿：presale 在除 /order 外的所有页面，postsale 在 /order 里且必须
-- 绑定订单。
--
-- 「一个用户同时只能有一个会话」和「售后按订单」这两条同时成立的唯一读法是：一个售前会话，加上每笔订单
-- 一个售后会话。下面的唯一索引就是这个读法——把 order_id 为空的售前会话折叠成同一个键，售后则按订单分开。
create table if not exists public.cs_sessions (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('presale','postsale')),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  agent_id uuid references auth.users(id) on delete set null,
  status text not null default 'open' check (status in ('open','closed')),
  subject text not null default '',
  -- §2.10 管理员介入的三种模式。none = 没有管理员在看。normal 是管理员以自己的身份进来一起说话；
  -- readonly 把客服降为只读（能看不能发）；blind 让客服彻底看不见这个会话的后续，由管理员接管。
  admin_mode text not null default 'none' check (admin_mode in ('none','normal','readonly','blind')),
  admin_id uuid references auth.users(id) on delete set null,
  -- §2.13 的两个率，落在会话行上而不是每次去 messages 里算：看板要按天聚合，扫消息表太贵。
  first_response_seconds integer, timed_out boolean not null default false,
  last_user_message_at timestamptz, last_agent_message_at timestamptz,
  -- §2.8 的活动超时。判定依据（发消息 / 正在打字）是站点配置，这里只记最后一次活动是什么时候。
  last_activity_at timestamptz not null default now(),
  reopened_count integer not null default 0,
  opened_at timestamptz not null default now(), closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null, close_reason text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  -- 售后必须有订单，售前必须没有。混着存的话「这个会话属于哪笔单」就没有确定答案。
  check ((channel='postsale' and order_id is not null) or (channel='presale' and order_id is null))
);
create unique index if not exists cs_one_open_session on public.cs_sessions(user_id,channel,coalesce(order_id,'00000000-0000-0000-0000-000000000000'::uuid)) where status='open';
create index if not exists cs_sessions_agent_idx on public.cs_sessions(agent_id,status) where status='open';
create index if not exists cs_sessions_queue_idx on public.cs_sessions(channel,created_at) where status='open' and agent_id is null;
create index if not exists cs_sessions_order_idx on public.cs_sessions(order_id) where order_id is not null;
create index if not exists cs_sessions_user_idx on public.cs_sessions(user_id,created_at desc);

-- §2.11 撤回与编辑，以及为什么必须拆成两张表。
--
-- Realtime 推的是这张表的原始行，不是视图。用户撤回一条消息之后，若原文还留在行里（哪怕只多一个
-- recalled=true 的标记），订阅了自己会话的用户就能在推送里读到自己刚撤回的原文——撤回等于没撤。所以撤回
-- 必须把 body 从行里真正搬走：原文进 cs_message_revisions，那张表只有客服能读，于是客服看到「已撤回」
-- 加原文，用户看到一条空壳。编辑同理，当前文本留在行里，上一版进 revisions，正好对上「编辑历史客服可见、
-- 用户不可见」。用视图做遮蔽在这里是无效的，Realtime 绕过视图。
create table if not exists public.cs_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.cs_sessions(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  -- system 是系统提示（会话已关闭之类），auto 是 §3 的自动回复。
  sender_role text not null check (sender_role in ('user','agent','admin','system','auto')),
  body text not null default '',
  -- §4 的四种格式。纯文本也算一种，因为「按纯文本显示」和「按 Markdown 渲染」结果不同。
  format text not null default 'markdown' check (format in ('plain','markdown','bbcode','html')),
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  -- §3.3：自动回复挂在客服名下（sender_id 是客服），但不计入 §2.13 的响应时间。少了这个标记，一句
  -- 「您好，请稍等」会让每个会话的首响时间都变成零点几秒，那个看板就再也测不出任何东西。
  auto_reply boolean not null default false, auto_reply_rule_id uuid,
  recalled boolean not null default false, recalled_at timestamptz,
  edited_at timestamptz, edit_count integer not null default 0,
  -- §2.10 blind 模式下管理员以客服身份发言：sender_id 写客服，真作者记在这里。用户看不出差别，审计看得出。
  authored_by uuid references auth.users(id) on delete set null,
  -- 介入本身的记录（谁进来了、切了哪个模式）不给用户看，所以要能逐条控制对用户的可见性。
  visible_to_user boolean not null default true,
  read_by_user_at timestamptz, read_by_agent_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists cs_messages_session_idx on public.cs_messages(session_id,created_at);

-- 用户撤回的原文和编辑前的版本都在这里。这张表的 RLS 是 §2.11 那条不对称可见性唯一的实现处，所以它
-- 没有任何面向用户的策略——不是漏写。
create table if not exists public.cs_message_revisions (
  id bigint generated always as identity primary key,
  message_id uuid not null references public.cs_messages(id) on delete cascade,
  session_id uuid not null references public.cs_sessions(id) on delete cascade,
  kind text not null check (kind in ('recall','edit')),
  body text not null default '', format text not null default 'markdown',
  attachments jsonb not null default '[]'::jsonb, revision integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists cs_message_revisions_message_idx on public.cs_message_revisions(message_id,revision);

-- §3 自动回复。三种触发方式共用一张表，因为产出物完全一样（一条挂在客服名下、不计响应时间的消息），
-- 区别只在什么时候发。
create table if not exists public.cs_auto_replies (
  id uuid primary key default gen_random_uuid(), name text not null default '', enabled boolean not null default true,
  trigger text not null check (trigger in ('keyword','order_paid','session_open')),
  -- 'both' 而不是存两行：同一句欢迎语售前售后都要发的情况，远比分别配置常见。
  channel text not null default 'both' check (channel in ('presale','postsale','both')),
  keywords text[] not null default '{}',
  match_mode text not null default 'contains' check (match_mode in ('contains','exact','starts_with','ends_with')),
  body text not null default '', format text not null default 'markdown' check (format in ('plain','markdown','bbcode','html')),
  -- 一个会话里只发一次，否则用户每提一次「退款」都收到同一段话。
  once_per_session boolean not null default true, priority integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- FK 单独加：cs_messages 建在前面，那时这张表还不存在。
do $$ begin
  alter table public.cs_messages add constraint cs_messages_auto_reply_rule_fkey
    foreign key (auto_reply_rule_id) references public.cs_auto_replies(id) on delete set null;
exception when duplicate_object then null; end $$;

-- §2.10 的介入记录、§2.12 的分配记录、§2.5 的开关记录都进这里。和 cs_messages 分开，因为这些是关于会话的
-- 事实，不是会话里的对话——混在一起的话，用户的聊天记录里会突然出现「管理员已切换为 blind 模式」。
create table if not exists public.cs_session_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.cs_sessions(id) on delete cascade,
  kind text not null, actor_id uuid references auth.users(id) on delete set null,
  actor_group text not null default '', detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists cs_session_events_session_idx on public.cs_session_events(session_id,created_at desc);

-- §9 站内信。单向通知，明确不可回复，所以这里没有任何回复相关的东西——要对话的场景走 §2 的会话。
--
-- 拆成 notifications + notification_receipts 是 §10.3 逼出来的：一条退款审批要发给所有管理员，而「谁读过」
-- 是每个管理员各自的事，「批准还是拒绝」却只有一个答案。把已读放在 notifications 行上，第一个点开的管理员
-- 就把这条对所有人标成了已读；给每个管理员各复制一行，审批状态又会出现多份互相矛盾的副本。
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  -- kind 的取值必须和 shared/notifications.mjs 的 NOTIFICATION_KINDS 完全一致，tests/api-smoke.mjs 对着断言。
  -- refund 和 refund_approval 是两回事：前者是「你的退款到哪一步了」这种告知，后者带审批按钮，
  -- §9.6 要求强制置顶高亮，presentationFor() 就靠这个区分。合成一个值等于让普通告知也占住置顶位。
  kind text not null default 'system' check (kind in ('system','admin','order','refund','refund_approval','session','ticket')),
  title text not null, body text not null default '',
  format text not null default 'markdown' check (format in ('plain','markdown')),
  -- §9.5 的可见范围。user 是发给某一个人，其余三种按角色广播。
  scope text not null default 'user' check (scope in ('user','admin','cs','all')),
  recipient_id uuid references auth.users(id) on delete cascade,
  -- §9.4 的操作按钮（退款审批的批准/拒绝/转交）。形状由 shared/notifications.mjs 校验。
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  -- §9.7 的三态。只有需要处理的通知才有状态，纯提醒是 null。
  state text check (state is null or state in ('pending','approved','rejected')),
  -- §9.6：待审批强制高亮置顶，读过也不许沉下去——事情没办完，它就该一直挡在眼前。
  pinned boolean not null default false, highlighted boolean not null default false,
  order_id uuid references public.orders(id) on delete cascade,
  refund_id uuid references public.refund_requests(id) on delete cascade,
  session_id uuid references public.cs_sessions(id) on delete set null,
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  -- user 范围必须有收件人，广播范围必须没有，否则「这条发给谁」没有确定答案。
  check ((scope='user' and recipient_id is not null) or (scope<>'user' and recipient_id is null))
);
create index if not exists notifications_recipient_idx on public.notifications(recipient_id,created_at desc) where recipient_id is not null;
create index if not exists notifications_scope_idx on public.notifications(scope,created_at desc);
create index if not exists notifications_refund_idx on public.notifications(refund_id) where refund_id is not null;

-- 每人一行的已读/归档。dwell_ms 要记，因为 §9.7 的已读判定是「点击或停留 2 秒」，两条路都得留下痕迹。
create table if not exists public.notification_receipts (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz, dwell_ms integer not null default 0, archived_at timestamptz,
  primary key (notification_id,user_id)
);
create index if not exists notification_receipts_user_idx on public.notification_receipts(user_id) where read_at is null;

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at = now(); return new; end $$;
create or replace function private.current_user_group() returns public.user_group
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select group_name from public.user_profiles where user_id = (select auth.uid())), 'default'::public.user_group)
$$;
revoke all on function private.current_user_group() from public;
grant usage on schema private to authenticated;
grant execute on function private.current_user_group() to authenticated;

-- §6's priority column, and the only place a group name is ranked. Switching on g::text is what lets
-- this file add enum values and use them in the same transaction (see the note above the enum).
-- Unknown names rank 0, so a group added to the enum without a rank here is powerless rather than
-- accidentally privileged.
create or replace function private.group_rank(g public.user_group) returns integer
language sql immutable set search_path = public, pg_temp as $$
  select case g::text
    when 'admin' then 999
    when 'cs' then 888
    when 'postsale' then 777
    when 'presale' then 777
    when 'coworker' then 555
    when 'read' then 111
    else 0 end
$$;
create or replace function private.my_rank() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select private.group_rank((select private.current_user_group()))
$$;
-- Named thresholds so the intent survives a later change of numbers.
--   is_staff  = presale/postsale/cs/admin — the groups that answer tickets (777+)
--   can_view_orders = read and up — §12.2, confirmed intentional: joining the org is how you get it
create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select private.my_rank() >= 777 $$;
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select private.my_rank() >= 999 $$;
create or replace function private.can_view_orders() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select private.my_rank() >= 111 $$;
-- Same threshold as can_view_orders, deliberately a second name: this one answers "is this an insider"
-- (drafts, disabled repos), the other answers §12.2. They coincide today and may not tomorrow.
create or replace function private.is_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select private.my_rank() >= 111 $$;
-- Editorial rights are NOT a rank threshold. §6's priority column ranks ticket dispatch, and a 售前客服
-- outranking 文案 there must not mean they can publish news. Enumerated on text, not the enum type, for
-- the transaction reason above.
create or replace function private.is_editor() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (select private.current_user_group())::text in ('coworker','admin')
$$;
revoke all on function private.group_rank(public.user_group) from public;
revoke all on function private.my_rank() from public;
revoke all on function private.is_staff() from public;
revoke all on function private.is_admin() from public;
revoke all on function private.can_view_orders() from public;
revoke all on function private.is_member() from public;
revoke all on function private.is_editor() from public;
grant execute on function private.group_rank(public.user_group),private.my_rank(),private.is_staff(),private.is_admin(),private.can_view_orders(),private.is_member(),private.is_editor() to authenticated;

-- 客服服务哪个渠道（§2.2）。cs 和 admin 两个渠道都接，presale/postsale 各守一个。
create or replace function private.serves_channel(ch text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case (select private.current_user_group())::text
    when 'admin' then true when 'cs' then true
    when 'presale' then ch = 'presale' when 'postsale' then ch = 'postsale'
    else false end
$$;
-- 会话可见性。§2.10 的 blind 模式在这里生效：管理员接管后原客服连会话都看不见。这是「客服彻底看不见」
-- 唯一说得通的实现处——只做在界面上的话，客服打开控制台就能把全部消息读回来。
create or replace function private.can_see_session(sid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.cs_sessions s where s.id = sid and (
    s.user_id = (select auth.uid()) or (select private.is_admin())
    or (s.agent_id = (select auth.uid()) and s.admin_mode <> 'blind')
    -- 待分配的会话要让有资格的客服看见，否则工作台里没有可接的单。
    or (s.agent_id is null and s.admin_mode <> 'blind' and (select private.serves_channel(s.channel)))))
$$;
-- 能不能发言，比可见更严：readonly 下客服只读（§2.10），已关闭的会话谁都不能再发（§2.5，重开是另一个动作）。
create or replace function private.can_post_session(sid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.cs_sessions s where s.id = sid and s.status = 'open' and (
    s.user_id = (select auth.uid()) or (select private.is_admin())
    or (s.agent_id = (select auth.uid()) and s.admin_mode not in ('blind','readonly'))))
$$;
-- 安全的 uuid 转换。存储策略要从对象路径里取会话 id，而 `'foo'::uuid` 是抛异常而不是返回 null——
-- 直接裸转的话，用户传一个路径不合规的文件拿到的是一句 SQL 报错而不是一次干净的拒绝，
-- 而报错和拒绝在客户端是两种完全不同的处理。immutable 是为了让它能用在策略里而不拖慢每行判定。
create or replace function private.to_uuid(s text) returns uuid
language plpgsql immutable set search_path = pg_temp as $$
begin return s::uuid; exception when others then return null; end $$;
-- §9.5 的可见范围。把列传进来而不是传行 id，策略里就不必对同一张表再查一次。
create or replace function private.can_see_notification(scope text, recipient uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case scope
    when 'user' then recipient = (select auth.uid())
    when 'admin' then (select private.is_admin())
    when 'cs' then (select private.is_staff())
    when 'all' then true else false end
$$;
-- 同一件事，但按通知 id 问。notification_receipts 的策略要判「这条通知我看得见吗」，没有它就得在一条
-- with check 里对同一行查两次（一次取 scope，一次取 recipient_id）。
create or replace function private.can_see_notification_id(nid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.notifications n where n.id = nid
    and private.can_see_notification(n.scope,n.recipient_id))
$$;
revoke all on function private.to_uuid(text) from public;
revoke all on function private.serves_channel(text) from public;
revoke all on function private.can_see_session(uuid) from public;
revoke all on function private.can_post_session(uuid) from public;
revoke all on function private.can_see_notification(text,uuid) from public;
revoke all on function private.can_see_notification_id(uuid) from public;
grant execute on function private.to_uuid(text),private.serves_channel(text),private.can_see_session(uuid),private.can_post_session(uuid),private.can_see_notification(text,uuid),private.can_see_notification_id(uuid) to authenticated;

-- §10.2：退款金额可改，但不得超过订单实付金额。check 约束读不到另一张表，所以只能是触发器；而它必须在
-- 数据库里，不能只在接口里——接口不是唯一的写入者，管理员直接改行、以后加的脚本、service client 都绕得过。
create or replace function private.enforce_refund_cap() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare paid integer; cur text;
begin
  select coalesce(o.paid_amount_minor,o.amount_minor), coalesce(nullif(o.paid_currency,''),o.currency)
    into paid, cur from public.orders o where o.id = new.order_id;
  if paid is null then raise exception '退款关联的订单不存在'; end if;
  -- 没填金额就按全额退：这是最常见的情况，也让历史行有值。
  if new.amount_minor is null then new.amount_minor := paid; end if;
  if new.currency is null then new.currency := cur; end if;
  if new.amount_minor < 0 then raise exception '退款金额不能为负'; end if;
  if new.amount_minor > paid then raise exception '退款金额 % 超过订单实付金额 %', new.amount_minor, paid; end if;
  return new;
end $$;
revoke all on function private.enforce_refund_cap() from public;
drop trigger if exists enforce_refund_cap on public.refund_requests;
create trigger enforce_refund_cap before insert or update of amount_minor,order_id,currency on public.refund_requests
  for each row execute function private.enforce_refund_cap();
update public.refund_requests r set amount_minor = coalesce(o.paid_amount_minor,o.amount_minor),
  currency = coalesce(nullif(o.paid_currency,''),o.currency) from public.orders o
  where o.id = r.order_id and r.amount_minor is null;

-- 核销优惠券。必须是一条带条件的 update：先 select 检查再 update 的写法，在两笔单同时结账时两边都会读到
-- 「还没满」，于是一张限量 1 的券被用两次。返回 0 行就说明已经满了或已失效。
-- 故意不 grant 给 authenticated：只有 service client 能调，用户不能自己核销。
create or replace function public.redeem_coupon(p_coupon uuid, p_user uuid, p_order uuid, p_discount integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare ok boolean;
begin
  update public.coupons set used_count = used_count + 1
    where id = p_coupon and enabled
      and (total_limit is null or used_count < total_limit)
      and (starts_at is null or starts_at <= now())
      and (ends_at is null or ends_at > now())
      and (allowed_user_ids = '{}' or p_user = any(allowed_user_ids))
      and (per_user_limit is null or (select count(*) from public.coupon_redemptions r
            where r.coupon_id = p_coupon and r.user_id = p_user) < per_user_limit)
  returning true into ok;
  if not coalesce(ok,false) then return false; end if;
  insert into public.coupon_redemptions(coupon_id,user_id,order_id,discount_minor)
    values(p_coupon,p_user,p_order,p_discount) on conflict(coupon_id,order_id) do nothing;
  return true;
end $$;
revoke all on function public.redeem_coupon(uuid,uuid,uuid,integer) from public;

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.user_profiles(user_id,email,display_name)
  values(new.id,new.email,coalesce(new.raw_user_meta_data->>'display_name',new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'user_name',''))
  on conflict(user_id) do update set email=excluded.email;
  return new;
end $$;
revoke all on function private.handle_new_user() from public;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert or update of email on auth.users for each row execute function private.handle_new_user();
do $$ declare t text; begin
  foreach t in array array['user_profiles','posts','progress_entries','repositories','site_settings','artifacts','payment_providers','orders','refund_requests','github_team_map','coupons','cs_agents','cs_sessions','cs_messages','cs_auto_replies','notifications']
  loop
    execute format('drop trigger if exists set_updated_at on public.%I',t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',t);
  end loop;
end $$;

-- 开 RLS 的表和清空旧策略的表必须是同一份名单。原来这份名单写了两遍，任何一次加表只改一处，就会得到
-- 一张开了 RLS 却留着上一版策略的表——最坏的一种，因为它照旧能读，只是按旧规则。所以现在只声明一次。
do $$
declare
  t text;
  r record;
  guarded text[] := array[
    'user_profiles','posts','progress_entries','repositories','site_settings','artifacts','payment_providers',
    'orders','refund_requests','installation_snapshots','telemetry_installs','github_team_map',
    'order_status_log','refund_audit_log','coupons','coupon_redemptions',
    'cs_agents','cs_sessions','cs_messages','cs_message_revisions','cs_auto_replies','cs_session_events',
    'notifications','notification_receipts'
  ];
begin
  foreach t in array guarded loop execute format('alter table public.%I enable row level security',t); end loop;
  for r in select policyname,tablename from pg_policies where schemaname='public' and tablename = any(guarded)
  loop execute format('drop policy if exists %I on public.%I',r.policyname,r.tablename); end loop;
end $$;

create policy profiles_read on public.user_profiles for select to authenticated
using ((select auth.uid())=user_id or (select private.is_admin()));
create policy profiles_admin_update on public.user_profiles for update to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
create policy published_posts_read on public.posts for select to anon,authenticated
using (status='published' or (select private.is_member()));
create policy editor_posts_insert on public.posts for insert to authenticated
with check ((select private.is_editor()));
create policy editor_posts_update on public.posts for update to authenticated
using ((select private.is_editor())) with check ((select private.is_editor()));
create policy editor_posts_delete on public.posts for delete to authenticated
using ((select private.is_editor()));
create policy progress_read on public.progress_entries for select to anon,authenticated using (true);
create policy editor_progress_insert on public.progress_entries for insert to authenticated
with check ((select private.is_editor()));
create policy editor_progress_update on public.progress_entries for update to authenticated
using ((select private.is_editor())) with check ((select private.is_editor()));
create policy editor_progress_delete on public.progress_entries for delete to authenticated
using ((select private.is_editor()));
create policy repositories_read on public.repositories for select to anon,authenticated using (enabled or (select private.is_member()));
create policy repositories_admin_insert on public.repositories for insert to authenticated with check ((select private.is_admin()));
create policy repositories_admin_update on public.repositories for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy repositories_admin_delete on public.repositories for delete to authenticated using ((select private.is_admin()));
create policy settings_admin on public.site_settings for all to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
create policy artifacts_read on public.artifacts for select to anon,authenticated using (active or (select private.is_admin()));
create policy artifacts_admin_insert on public.artifacts for insert to authenticated with check ((select private.is_admin()));
create policy artifacts_admin_update on public.artifacts for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy artifacts_admin_delete on public.artifacts for delete to authenticated using ((select private.is_admin()));
create policy providers_read on public.payment_providers for select to authenticated using (enabled or (select private.is_admin()));
create policy providers_admin_insert on public.payment_providers for insert to authenticated with check ((select private.is_admin()));
create policy providers_admin_update on public.payment_providers for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy providers_admin_delete on public.payment_providers for delete to authenticated using ((select private.is_admin()));
-- §12.2: read and up see every order, not just their own. Confirmed intentional — being in the
-- AetherAC org is what grants it. Buyers still see only their own rows.
create policy own_orders_read on public.orders for select to authenticated
using ((select auth.uid())=user_id or (select private.can_view_orders()));
create policy admin_orders_update on public.orders for update to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
-- Staff read refunds because §5 has the post-sales agent looking at the order's refund while answering.
create policy own_refunds_read on public.refund_requests for select to authenticated
using ((select auth.uid())=user_id or (select private.is_staff()));
create policy own_refunds_insert on public.refund_requests for insert to authenticated
with check ((select auth.uid())=user_id and exists(select 1 from public.orders o where o.id=order_id and o.user_id=(select auth.uid()) and o.status='paid'));
create policy admin_refunds_update on public.refund_requests for update to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
create policy team_map_read on public.github_team_map for select to authenticated using ((select private.is_admin()));
create policy team_map_admin on public.github_team_map for all to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
create policy install_stats_read on public.installation_snapshots for select to anon,authenticated using (true);
-- Only the rollup above is public. A telemetry row names one server's hwid, its licence code and its
-- exact versions — an unpatched version on a reachable install is an attacker's shopping list — so the
-- raw table is admin-only, and no policy grants insert: samples arrive through the service client in
-- api/telemetry.mjs, which is the only writer.
create policy telemetry_admin_read on public.telemetry_installs for select to authenticated
using ((select private.is_admin()));

-- §12.5 的订单日志跟着订单的可见性走：能看这笔单的人，就能看这笔单的历史。
create policy order_log_read on public.order_status_log for select to authenticated
using ((select private.can_view_orders()) or exists(select 1 from public.orders o where o.id=order_id and o.user_id=(select auth.uid())));
-- §10.6：客服要能看自己发起的退款进展，所以是 staff 而不只是 admin；用户看自己那一笔。
create policy refund_audit_read on public.refund_audit_log for select to authenticated
using ((select private.is_staff()) or exists(select 1 from public.refund_requests r where r.id=refund_id and r.user_id=(select auth.uid())));
-- §1：管理员和客服都能建券。删除留给管理员——已核销记录会指向被删掉的券。
-- 买家永远不直接读这张表：券的条件（限哪些 SKU、限哪些用户、还剩几张）本身就是不该外泄的信息。校验走
-- api/coupon.mjs，用户手上只有订单行里的 coupon_code 快照，而 §5 要显示的正是那一份。
create policy coupons_staff_read on public.coupons for select to authenticated using ((select private.is_staff()));
create policy coupons_staff_insert on public.coupons for insert to authenticated with check ((select private.is_staff()));
create policy coupons_staff_update on public.coupons for update to authenticated
using ((select private.is_staff())) with check ((select private.is_staff()));
create policy coupons_admin_delete on public.coupons for delete to authenticated using ((select private.is_admin()));
create policy coupon_redemptions_read on public.coupon_redemptions for select to authenticated
using (user_id=(select auth.uid()) or (select private.is_staff()));

-- 以下 cs_* 表对浏览器只读。每一次写都有服务端后果：分配要原子地挑一个客服（§2.12），撤回要在同一个事务里
-- 把原文搬进 revisions（§2.11），首次回复要盖上 §2.13 的响应时间，用户发言之后要触发自动回复（§3）。浏览器
-- 保证不了这些，所以写入统一走 api/cs-*.mjs 的 service client；Realtime 推的仍是插入后的行，聊天只多一个
-- HTTP 往返。唯一的例外是 cs_agents 的心跳：几十秒一次、没有任何连带后果，绕接口纯属浪费。
create policy cs_agents_read on public.cs_agents for select to authenticated
using (user_id=(select auth.uid()) or (select private.is_staff()));
create policy cs_agents_self_insert on public.cs_agents for insert to authenticated
with check (user_id=(select auth.uid()) and (select private.is_staff()));
-- 只能改自己那一行，而且改不到 max_concurrent——那是 §2.7 给管理员的权限。拦住它的是下面的列级 grant，
-- 不是这条策略：策略决定得了哪一行，决定不了哪一列。
create policy cs_agents_self_update on public.cs_agents for update to authenticated
using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
create policy cs_sessions_read on public.cs_sessions for select to authenticated using ((select private.can_see_session(id)));
create policy cs_messages_read on public.cs_messages for select to authenticated
using ((select private.can_see_session(session_id)) and (visible_to_user or (select private.is_staff())));
-- §2.11 的不对称落在这一条上：撤回的原文和编辑前的版本只有客服读得到。没有面向用户的策略，不是漏写。
create policy cs_revisions_staff_read on public.cs_message_revisions for select to authenticated
using ((select private.is_staff()) and (select private.can_see_session(session_id)));
create policy cs_auto_replies_read on public.cs_auto_replies for select to authenticated using ((select private.is_staff()));
create policy cs_auto_replies_admin on public.cs_auto_replies for all to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
-- 介入记录只给客服和管理员：让用户读到「管理员已切换为 blind」，blind 就白设了。
create policy cs_events_staff_read on public.cs_session_events for select to authenticated
using ((select private.is_staff()) and (select private.can_see_session(session_id)));

create policy notifications_read on public.notifications for select to authenticated
using ((select private.can_see_notification(scope,recipient_id)));
create policy notifications_admin_write on public.notifications for all to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
-- 已读和归档是每人自己的事，直接写库：§9.7 的「停留 2 秒」判定本来就发生在浏览器里，绕接口只是加延迟。
create policy notification_receipts_own on public.notification_receipts for select to authenticated using (user_id=(select auth.uid()));
create policy notification_receipts_insert on public.notification_receipts for insert to authenticated
with check (user_id=(select auth.uid()) and (select private.can_see_notification_id(notification_id)));
create policy notification_receipts_update on public.notification_receipts for update to authenticated
using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('refund-evidence','refund-evidence',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- §4.2/§4.5/§4.6 的聊天附件。一个桶三种限额（图片 10MB / 文件 25MB / 视频 100MB）装不下，因为 buckets 只有
-- 一个 file_size_limit，所以这里取三者的最大值 100MB 当硬顶，分类型的限额由 API 按 site_settings 里那三个键判。
-- 也就是说存储层是最后一道墙而不是唯一一道墙：前端拦一次给出体面的提示，API 拦一次是可信判定，桶这一层
-- 只保证「就算前两层都被绕过，也不会有人往里塞 2GB」。改 site_settings 里的上限时不必动这里，除非要超过 100MB。
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('cs-attachments','cs-attachments',false,104857600,array[
  'image/jpeg','image/png','image/webp','image/gif',
  'application/pdf','text/plain','application/zip','application/json',
  'video/mp4','video/webm'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists cs_attach_insert on storage.objects;
drop policy if exists cs_attach_read on storage.objects;
-- 路径约定 {session_id}/{uid}/{文件名}：第一段是会话 id，可见性就能直接复用 can_see_session，不必再为
-- 附件维护一套单独的成员表。第二段是上传者，保留它是为了「谁传的」在存储层也留痕，而不只在消息行里。
-- 写入用 can_post_session：会话关了就传不进来，否则超时关闭后附件还能继续堆进历史会话。
create policy cs_attach_insert on storage.objects for insert to authenticated
with check(bucket_id='cs-attachments'
  and (storage.foldername(name))[2]=(select auth.uid()::text)
  and (select private.can_post_session(private.to_uuid((storage.foldername(name))[1]))));
create policy cs_attach_read on storage.objects for select to authenticated
using(bucket_id='cs-attachments' and (select private.can_see_session(private.to_uuid((storage.foldername(name))[1]))));
drop policy if exists refund_evidence_insert on storage.objects;
drop policy if exists refund_evidence_read on storage.objects;
create policy refund_evidence_insert on storage.objects for insert to authenticated
with check(bucket_id='refund-evidence' and (storage.foldername(name))[1]=(select auth.uid()::text));
-- Staff, not just admins: §10.3 has the reviewer looking at the evidence the agent attached.
create policy refund_evidence_read on storage.objects for select to authenticated
using(bucket_id='refund-evidence' and (owner_id=(select auth.uid()::text) or (select private.is_staff())));

-- 这一段是权限的完整声明，不是「默认值 + 几条补充」。必须先收回再发，原因在 pg_default_acl 里：
-- Supabase 给 public schema 预设了 `anon=arwdDxtm,authenticated=arwdDxtm`（表）和 `anon=X,authenticated=X`
-- （函数），也就是说每一张 create table 出来的表都自带匿名 insert/update/delete，每一个 create function
-- 出来的函数都自带匿名 execute。挡住它的只有 RLS。
-- 光靠 RLS 有两个问题。一是它挡不住 security definer 函数——那种函数本来就绕过 RLS，一旦匿名可调就是直通车。
-- 二是纵深只有一层：谁哪天加一条宽松的写策略、或者新建表时漏了 enable row level security，写入当场就通。
-- 还有一点容易被忽略：RLS 决定改哪一行，决定不了改哪一列。表级 UPDATE 一给，列级 grant 就等于没写
-- （cs_agents.max_concurrent 就是踩过的那个坑），所以要靠列级授权就必须先把表级的收掉。
-- 注意 revoke all 也会连列级授权一起收掉，所以下面的列级 grant 必须排在这个循环之后。
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname='public'
  loop execute format('revoke all on public.%I from anon,authenticated',r.tablename); end loop;
  -- 函数同理，而且这一半更要紧：public 下唯一的非触发器函数是 redeem_coupon，它是 security definer，
  -- 也就是说它绕过 RLS。默认权限让 anon 都能调它，于是任何人都能拿任意 (coupon,user,order) 去核销一张券——
  -- 绕开 per-user 上限、往别人的订单上记核销。上面那句 `revoke ... from public` 收的是 PUBLIC 伪角色，
  -- 跟直接授给 anon/authenticated 的权限是两码事，一条都没撤掉。这里按角色收才真的收掉。
  -- 排除返回 trigger 的函数不是因为收了会坏（触发器不查调用者的 execute 权限），而是为了让这个循环的意图
  -- 保持单一：它管的是「谁能主动调用什么」。set_updated_at 谁都调不动，也没有可调的意义。
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.prorettype <> 'trigger'::regtype
  loop execute format('revoke all on function %s from anon,authenticated',r.sig); end loop;
end $$;
-- storage.objects 的表级权限故意不动。Supabase 的存储 API 就架在那套默认授权上，收掉等于所有上传下载全断；
-- 那张表的闸门是 RLS 策略（上面 refund_evidence_* 和 cs_attach_* 那四条），不是表权限。
grant select on public.posts,public.progress_entries,public.repositories,public.artifacts,public.installation_snapshots to anon;
grant select on all tables in schema public to authenticated;
grant insert on public.refund_requests to authenticated;
grant update on public.orders to authenticated;
grant update on public.user_profiles,public.posts,public.progress_entries,public.repositories,public.site_settings,public.artifacts,public.payment_providers,public.refund_requests to authenticated;
grant insert,delete on public.posts,public.progress_entries,public.repositories,public.site_settings,public.artifacts,public.payment_providers to authenticated;
-- team_map_admin is a `for all` policy, so it needs the table grants to match or admins get a bare
-- permission denied instead of an RLS decision. select already comes from the blanket grant above.
grant insert,update,delete on public.github_team_map to authenticated;
-- 同一条教训再用一次：notifications 和 cs_auto_replies 上的 `for all` 策略要配上对应的表权限，否则管理员拿到的是一句 permission denied，而不是一次 RLS 判定。
grant insert,update,delete on public.notifications,public.cs_auto_replies to authenticated;
grant insert,update on public.coupons to authenticated;
grant delete on public.coupons to authenticated;
grant insert,update on public.notification_receipts to authenticated;
-- 列级权限，因为 §2.7 的并发上限归管理员。RLS 只能决定客服改得了哪一行，决定不了他改不了哪一列——少了这两行，客服把自己的 max_concurrent 调成 999 就绕过了分配上限。
grant insert(user_id,online,last_heartbeat,status_note) on public.cs_agents to authenticated;
grant update(online,last_heartbeat,status_note) on public.cs_agents to authenticated;
-- 故意不给的：cs_sessions、cs_messages、cs_message_revisions、cs_session_events、order_status_log、refund_audit_log、coupon_redemptions 都没有 insert/update。它们只由 service client 写（见上面 cs_* 策略那段注释），日志和审计流水更是只能追加不能改——能改的审计日志不叫审计日志。

insert into public.payment_providers(id,display_name,secret_env_names,instructions,sort_order) values
('moonpay','MoonPay',array['MOONPAY_API_KEY','MOONPAY_SECRET_KEY','MOONPAY_WEBHOOK_SECRET'],'1. Create a MoonPay business account and obtain API/signing keys. 2. Add the listed secrets in Environment. 3. Configure checkout_url_template for the MoonPay widget, including order_id and callback_url. 4. Register /v1/callback/moonpay and set webhook_signature_header/webhook_secret_env. 5. Test in sandbox before enabling.',10),
('code','Code SDK',array['CODE_WALLET_PRIVATE_KEY','CODE_WEBHOOK_SECRET'],'1. Provision a dedicated Code wallet. 2. Store the private key only in Environment. 3. Deploy a server-side Code payment-request endpoint and set it as create_url. 4. Return checkout_url and id fields. 5. Normalize confirmation callbacks to /v1/callback/code.',30),
('wechat','WeChat Pay',array['WECHAT_MCH_ID','WECHAT_API_V3_KEY','WECHAT_PRIVATE_KEY','WECHAT_CERT_SERIAL','WECHAT_WEBHOOK_SECRET'],'1. Complete WeChat Pay merchant onboarding. 2. Add merchant ID, API v3 key, merchant private key and certificate serial. 3. Configure a server-side JSAPI/Native/H5 order adapter as create_url. 4. Set notify_url to /v1/callback/wechat. 5. Verify certificates and decrypt callback resources in the adapter before forwarding normalized HMAC.',40),
('alipay','Alipay',array['ALIPAY_APP_ID','ALIPAY_PRIVATE_KEY','ALIPAY_PUBLIC_KEY','ALIPAY_WEBHOOK_SECRET'],'1. Create an Alipay application and enable the required product. 2. Add APP_ID and RSA2 keys. 3. Configure a server-side page-pay or trade-precreate adapter as create_url. 4. Set notify_url to /v1/callback/alipay. 5. Verify Alipay signatures in the adapter before normalized forwarding.',50),
('coinbase','Coinbase Commerce',array['COINBASE_API_KEY','COINBASE_WEBHOOK_SECRET'],'1. Create a Coinbase Commerce account and API key. 2. Configure create_url for the charge endpoint, X-CC-Api-Key in create_headers and order metadata in create_body. 3. Map hosted_url to checkout_url_path. 4. Register /v1/callback/coinbase and set webhook_signature_header to x-cc-webhook-signature. 5. Test a charge and delayed confirmation.',60),
('binance','Binance Pay',array['BINANCE_PAY_API_KEY','BINANCE_PAY_SECRET','BINANCE_WEBHOOK_SECRET'],'1. Complete Binance Pay merchant onboarding. 2. Add certificate API key and signing secret. 3. Configure a server-side signed order adapter as create_url. 4. Return checkoutUrl and prepayId. 5. Verify Binance timestamp/nonce/certificate callback in the adapter and forward to /v1/callback/binance.',70),
('plisio','Plisio',array['PLISIO_SECRET_KEY','PLISIO_WEBHOOK_SECRET'],'1. Create a Plisio store and secret key. 2. Configure create_url/create_body for invoice creation. 3. Set callback_url to /v1/callback/plisio and map invoice_url/id. 4. Configure webhook_secret_env and signature header for a normalized adapter. 5. Test pending, confirmed, expired and overpayment states.',80),
('payless','Payless',array['PAYLESS_API_KEY','PAYLESS_WEBHOOK_SECRET'],'1. Obtain merchant API documentation and credentials from Payless. 2. Configure create_url, create_headers, create_body and response paths. 3. Register /v1/callback/payless. 4. Configure HMAC signature header/secret. 5. Test success, failure, duplicate callback and refund flows.',90)
on conflict(id) do update set secret_env_names=excluded.secret_env_names,instructions=excluded.instructions,sort_order=excluded.sort_order;

-- Stripe, PayPal and PayerURL are driven by api/_lib/payments.mjs instead of the configurable
-- create_url path, so public_config.driver is what makes them work. The jsonb concat below keeps any
-- key already in the row (notably paypal.environment='sandbox') from being reset on a re-run.
insert into public.payment_providers(id,display_name,public_config,secret_env_names,instructions,sort_order) values
('stripe','Stripe','{"driver":"stripe"}'::jsonb,array['STRIPE_SECRET_KEY'],'1. 在 Stripe 控制台 Developers → API keys 取 Secret key（正式环境是 sk_live_ 开头，测试环境 sk_test_ 开头）。2. 在“环境变量”页添加 STRIPE_SECRET_KEY，勾选敏感值。3. 在 Stripe 控制台 Developers → Webhooks 添加端点 https://aetherac.abnt.it/v1/callback/stripe，事件勾选 checkout.session.completed 和 checkout.session.expired；这里不需要 webhook 密钥，回调收到后会反查 Stripe 的会话状态来确认收款。4. 重新部署后回到本页勾选“对外启用”。5. 用 sk_test_ 密钥下一单验证，Stripe 会跳转回 /order?order_id=<订单号>。',1),
('paypal','PayPal','{"driver":"paypal","environment":"live"}'::jsonb,array['PAYPAL_CLIENT_ID','PAYPAL_SECRET'],'1. 在 PayPal Developer Dashboard 创建 App，取 Client ID 与 Secret（沙盒和正式是两套）。2. 在“环境变量”页添加 PAYPAL_CLIENT_ID 和 PAYPAL_SECRET，勾选敏感值。3. 要先用沙盒测试就把本行“公开配置”里的 environment 改成 sandbox，正式收款时改回 live。4. 在 App 的 Webhooks 里添加 https://aetherac.abnt.it/v1/callback/paypal，事件勾选 CHECKOUT.ORDER.APPROVED 和 PAYMENT.CAPTURE.COMPLETED；买家批准后由服务端调用 capture 真正扣款，capture 成功才算已付款。5. 重新部署后回到本页勾选“对外启用”。',2),
('payerurl','PayerURL','{"driver":"payerurl"}'::jsonb,array['PAYERURL_PUBLIC_KEY','PAYERURL_SECRET_KEY'],'1. 在 dash.payerurl.com → Profile → Get API credentials 取 Public key 和 Secret key，这两把就是全部凭据，PayerURL 不另发 webhook 密钥。2. 在“环境变量”页添加 PAYERURL_PUBLIC_KEY 和 PAYERURL_SECRET_KEY，勾选敏感值。3. 商户后台没有“回调地址”这一项，不用去找：回调地址（notify_url）随每一笔订单一起发给 PayerURL，本站自动填 https://aetherac.abnt.it/v1/callback/payerurl。回调用同一把 Secret key 做 HMAC-SHA256 校验，所以不需要第三个密钥。4. 重新部署后回到本页勾选“对外启用”。5. 先下一笔小额真单验证：只有 status_code 为 200 且到账金额不低于订单金额时才会标记为已付款；金额不足会被拒绝，仍在链上等确认的会留在“待支付”，等下一次回调再结算。',3)
on conflict(id) do update set
  public_config=excluded.public_config||payment_providers.public_config,
  secret_env_names=excluded.secret_env_names,instructions=excluded.instructions,sort_order=excluded.sort_order;

-- §11/§14 的配置项。value 一律包一层 {"value":...}，因为 site_settings.value 是 jsonb 而 jsonb 的顶层标量在
-- PostgREST 里取回来是裸值，前端拿到 `30` 和拿到 `{"value":30}` 的解包代码不一样；统一包一层，读取端就只有一条路径。
-- 注意 on conflict 只更新 description，不动 value：支付渠道那段是每次重跑都刷新 instructions，配置项必须相反——
-- value 是管理员在后台调出来的，重跑一次 schema 就把人家设好的 48 小时打回默认，那是丢数据，不是幂等。
insert into public.site_settings(key,value,description) values
-- §9.6/§11：站内信自动归档。0 表示永不自动归档，留给不想让审批记录消失的站点。
('notification_auto_archive_days','{"value":30}'::jsonb,'站内信多少天后自动归档；0 = 不自动归档'),
-- §9.8：未读提醒方式。分开成两个开关而不是一个四选一的枚举，因为「浏览器 + 邮件」是很常见的组合，
-- 用枚举就得写 both 这种值，加第三种渠道时又要改枚举。
('notification_notify_browser','{"value":true}'::jsonb,'未读站内信是否推浏览器通知'),
('notification_notify_email','{"value":false}'::jsonb,'未读站内信是否发邮件提醒'),
-- §9.7：未读转已读的停留时长。点击即读是硬编码的，这个值只管「停留够久也算读过」那条路。
('notification_read_dwell_ms','{"value":2000}'::jsonb,'站内信在可视区停留多少毫秒算已读'),
-- §10.5：审批超时。超时本身不改状态，只升级提醒——退款是钱的事，不能因为没人看就自动过或自动拒。
('refund_approval_timeout_hours','{"value":48}'::jsonb,'退款审批多少小时未处理算超时并升级提醒'),
('refund_reminder_interval_hours','{"value":24}'::jsonb,'超时后每隔多少小时重复提醒一次'),
-- §10.2/§14：客服能不能改退款金额。默认给，因为部分退款是真实需求；上限由 enforce_refund_cap 触发器兜着，
-- 所以这个开关关掉是「只能整单退」，不是「防超额」——防超额在数据库里，不在这个开关里。
('refund_cs_can_edit_amount','{"value":true}'::jsonb,'客服发起退款时是否可以修改金额（上限恒为订单实付额）'),
-- §14：自动退款。默认 false 且短期内不该改成 true——PayerURL 没有退款 API，加密货币出款是人工转账，
-- 打开这个开关不会让钱自动退出去，只会让状态机走到一个没有执行者的 executing。
('refund_auto_execute','{"value":false}'::jsonb,'批准后是否自动执行退款；PayerURL 无退款接口，加密渠道必须保持 false'),
-- §13.4：不可逆操作的二次确认。默认 true，且后台不提供关闭入口的理由写在这里：能一键点掉的确认框等于没有确认框。
('refund_require_second_confirm','{"value":true}'::jsonb,'标记「退款成功」等不可逆操作是否强制二次确认'),
('refund_auto_notify','{"value":true}'::jsonb,'退款状态变化是否自动给用户发站内信'),
-- §12.2：订单列表分页。上限在 API 里另有硬顶，这里只是默认值——否则把它调成 100000 就是一次自助的全表导出。
('order_list_page_size','{"value":20}'::jsonb,'订单管理页每页条数'),
('order_export_enabled','{"value":true}'::jsonb,'是否允许批量导出订单（CSV/Excel）'),
-- §14：日志保留。order_status_log 和 refund_audit_log 都是只追加的，这个值交给清理任务用；
-- 设 0 表示永久保留，审计口径上比自动删更安全。
('audit_log_retention_days','{"value":0}'::jsonb,'订单/退款日志保留天数；0 = 永久保留'),
-- §2.7：并发会话上限的全站默认值。cs_agents.max_concurrent 为 null 时落到这里，所以调整默认值不用逐个改人。
('cs_max_concurrent_default','{"value":5}'::jsonb,'客服同时接待的会话数上限（全站默认）'),
-- §2.5：心跳超时。比活动超时短一个量级，因为它判的是「浏览器还在吗」，不是「人还在吗」。
('cs_heartbeat_timeout_seconds','{"value":90}'::jsonb,'心跳中断多少秒后判定客服离线'),
-- §2.8：活动超时的判定依据。'message' = 只算发出去的消息，'typing' = 正在打字也算活跃。
('cs_activity_basis','{"value":"message"}'::jsonb,'活动超时依据：message = 以发消息为准，typing = 打字也算活跃'),
-- §7.2：打字状态的触发时机。'focus' = 聚焦输入框就广播，'keypress' = 真的敲了键才广播。
('cs_typing_trigger','{"value":"keypress"}'::jsonb,'对方「正在输入」的触发时机：focus = 聚焦输入框，keypress = 实际键入'),
-- §2.9：分渠道的会话超时，以及超时后给两边看的文案。用户看的和客服看的必须分开——同一句「会话已超时关闭」
-- 对用户是解释，对客服是绩效，措辞不可能通用。
('cs_timeout_presale_minutes','{"value":10}'::jsonb,'售前会话无活动多少分钟后自动关闭'),
('cs_timeout_postsale_minutes','{"value":30}'::jsonb,'售后会话无活动多少分钟后自动关闭'),
('cs_timeout_text_presale_user','{"value":"由于长时间无人应答，本次售前咨询已自动关闭。您可以随时重新发起咨询。"}'::jsonb,'售前超时给用户看的文案'),
('cs_timeout_text_presale_agent','{"value":"该售前会话因超时自动关闭，已计入超时率。"}'::jsonb,'售前超时给客服看的文案'),
('cs_timeout_text_postsale_user','{"value":"本次售后会话因长时间无新消息已自动关闭。如问题未解决，可在订单页重新发起。"}'::jsonb,'售后超时给用户看的文案'),
('cs_timeout_text_postsale_agent','{"value":"该售后会话因超时自动关闭，已计入超时率。"}'::jsonb,'售后超时给客服看的文案'),
-- §2.12：没有在线客服时的兜底文案。这条一定要能改，因为它是用户在最差情况下唯一看到的东西。
('cs_no_agent_text','{"value":"当前客服均不在线，请留下您的问题，我们会在上线后第一时间回复。"}'::jsonb,'无在线客服时展示给用户的文案'),
('cs_welcome_text','{"value":"您好，请描述您遇到的问题，我们会尽快为您处理。"}'::jsonb,'§3.3 会话建立时的默认欢迎语'),
-- §4：上传限制。这里的数字必须和 storage.buckets 的 file_size_limit 对齐，否则前端放过去、存储层拒收，
-- 用户看到的是一次没有理由的失败。改这里就要同步改上面 buckets 那段。
('cs_upload_max_image_mb','{"value":10}'::jsonb,'聊天图片单个大小上限（MB）'),
('cs_upload_max_file_mb','{"value":25}'::jsonb,'聊天文件单个大小上限（MB）'),
('cs_upload_max_video_mb','{"value":100}'::jsonb,'聊天视频单个大小上限（MB）'),
-- §4.4：HTML 允许与否。默认 false——§4.4 要求过滤 <script>，但白名单式的 HTML 清洗在客户端从来不是可信边界，
-- 打开它就等于承认富文本注入的风险换排版自由，这个取舍应该是管理员显式做出的。
('cs_allow_html','{"value":false}'::jsonb,'聊天消息是否允许内联 HTML（会过滤 <script>，但仍有注入面）'),
('cs_allow_bbcode','{"value":true}'::jsonb,'聊天消息是否解析 BBCode')
on conflict(key) do update set description=excluded.description;

-- Bootstrap the first administrator after registration:
-- update public.user_profiles set group_name='admin' where email='contact@abnt.it';
