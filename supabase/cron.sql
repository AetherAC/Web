-- 站点的定时任务。schema.sql 之后单独跑一次，不写在那个文件里。
--
-- 为什么分成两个文件：schema.sql 整段是一个事务，而这里第一句 create extension pg_cron 在没有把它
-- 放进 shared_preload_libraries 的实例上会直接失败。写在 schema.sql 里的话，一次装不上会把后面几百行
-- 表结构一起回滚——一个可选的定时任务把整个建库脚本拖下水。分开之后，装不上就只是没有定时任务。
--
-- 为什么定时任务在数据库里，而不是 Vercel Cron：Hobby 计划只给 2 个 cron 且每天只触发一次，而会话
-- 超时（最短 10 分钟）和心跳失联（90 秒）要的是分钟级。另一条路是 pg_cron 用 pg_net 回调站点接口，
-- 那样业务逻辑只有一份，但要在库里存一个能调管理员接口的密钥，还要自己去 net._http_response 里翻
-- 失败——而下面这四件事都能用一条 SQL 说清。代价是 §2.9 的超时文案和 §10.5 的通知正文在 JS 和 SQL
-- 各有一份实现，这一点由 tests/api-smoke.mjs 读本文件的文本对着断言钉住。
--
-- 幂等：整个文件可以重复跑。函数都是 create or replace，任务先 unschedule 再 schedule。
--
-- 出了问题看这张表：select * from cron.job_run_details order by start_time desc limit 20;
-- 四件事拆成四个 job 而不是一个总入口挨个调，就是为了让那张表能指出是哪一件失败的——合成一个的话，
-- 心跳清理报错会顺带把同一次运行里的会话超时也标成失败，而它其实跑完了。

create extension if not exists pg_cron;
-- Supabase 上任务是以 postgres 身份跑的，这两句是它调 cron.schedule 的前提。
grant usage on schema cron to postgres;

-- §14 的配置读取。所有值都存成 {"value": ...}（见 schema.sql 的 seed 段），所以统一从 '{value}' 取。
-- 用 #>> 取成文本再转数字，而不是 (value->'value')::numeric：后者依赖 jsonb→numeric 的转换，那是
-- PG 11 才有的，而这个文件没有理由去挑运行版本。
--
-- 值不是数字时这里会抛，而不是退回 fallback：一个填错的超时阈值应该让任务在 job_run_details 里红一次，
-- 而不是静悄悄按 48 小时跑下去——后者的表现是「配置改了但没生效」，那是最难查的一类。
create or replace function private.setting_num(p_key text, p_fallback numeric)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select nullif(value #>> '{value}', '') from public.site_settings where key = p_key)::numeric,
    p_fallback)
$$;
revoke all on function private.setting_num(text, numeric) from public;

create or replace function private.setting_text(p_key text, p_fallback text)
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    nullif((select value #>> '{value}' from public.site_settings where key = p_key), ''),
    p_fallback)
$$;
revoke all on function private.setting_text(text, text) from public;

-- shared/coupons.mjs 的 formatMinor 的第二份实现，只用在下面那条超时提醒的正文里。
--
-- 零小数位的币种不能除 100，除了就把 1000 日元显示成 10 日元。这份名单必须和那边的
-- ZERO_DECIMAL_CURRENCIES 逐字一致，tests/api-smoke.mjs 读本文件断言——两边分叉的后果不是报错，
-- 而是同一笔退款在收件箱里显示成两个金额（原通知按 JS 那份，超时提醒按这份）。
create or replace function private.format_minor(p_minor integer, p_currency text)
returns text language sql immutable set search_path = pg_temp as $$
  select case
    when c is null then n
    when c in ('JPY','KRW','VND','CLP','ISK','BIF','DJF','GNF','KMF','MGA','PYG','RWF','UGX','VUV','XAF','XOF','XPF')
      then coalesce(p_minor, 0)::text || ' ' || c
    else n || ' ' || c
  end
  from (select nullif(upper(btrim(coalesce(p_currency, ''))), '') as c,
               to_char(coalesce(p_minor, 0)::numeric / 100, 'FM999999999990.00') as n) t
$$;
revoke all on function private.format_minor(integer, text) from public;

-- 订单号的展示形式，和 api/_routes/refund-request.mjs 的 orderNoOf 同一个规则：库里没有单独的订单号列，
-- id 就是订单号，只在标题里截短。uuid 的第 9 位是连字符，所以取前 8 位不会截出半个分段。
create or replace function private.order_no(p_order uuid)
returns text language sql immutable set search_path = pg_temp as $$
  select upper(left(p_order::text, 8))
$$;
revoke all on function private.order_no(uuid) from public;

-- §2.8/§2.9 会话超时关闭。api/_routes/cs-session.mjs 的 sweepIdleSessions 是同一件事的手动入口
-- （那个只有管理员点得动），这里是那个函数注释里说的「给定时任务用」的那个定时任务。
--
-- 两个渠道的阈值不同，所以条件里按 channel 分开写，而不是取两者的最小值扫一遍再在外面筛：售前 10
-- 分钟、售后 30 分钟，取最小值会把一个刚过 12 分钟的售后会话也拉出来。
--
-- 阈值 <= 0 视为「这个渠道不自动关」。0 是管理员关掉这个功能的方式，不是「立刻关」——把它读成 0 分钟
-- 超时的话，改配置的人会瞬间关掉全站所有会话。
create or replace function private.cs_close_idle_sessions(p_limit integer default 200)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_presale  integer := coalesce(private.setting_num('cs_timeout_presale_minutes', 0), 0)::integer;
  v_postsale integer := coalesce(private.setting_num('cs_timeout_postsale_minutes', 0), 0)::integer;
  v_closed integer := 0;
  v_user_text text;
  v_agent_text text;
  s record;
begin
  if v_presale <= 0 and v_postsale <= 0 then return 0; end if;

  for s in
    select id, channel from public.cs_sessions
     where status = 'open'
       and ((channel = 'presale'  and v_presale  > 0 and last_activity_at < now() - make_interval(mins => v_presale))
         or (channel = 'postsale' and v_postsale > 0 and last_activity_at < now() - make_interval(mins => v_postsale)))
     order by last_activity_at
     limit p_limit
  loop
    -- 再判一次 status='open'：上面那个查询是快照，这一瞬间用户可能正在手动关闭同一个会话。拿不到行
    -- 就说明别人赢了，那时不该再发一遍超时文案——JS 那份用的是同一条件，理由也同一个。
    update public.cs_sessions
       set status = 'closed', closed_at = now(), close_reason = 'timeout',
           timed_out = true, updated_at = now()
     where id = s.id and status = 'open';
    if not found then continue; end if;

    if s.channel = 'presale' then
      v_user_text  := private.setting_text('cs_timeout_text_presale_user', '会话已自动关闭。');
      v_agent_text := private.setting_text('cs_timeout_text_presale_agent', '该会话因超时自动关闭。');
    else
      v_user_text  := private.setting_text('cs_timeout_text_postsale_user', '会话已自动关闭。');
      v_agent_text := private.setting_text('cs_timeout_text_postsale_agent', '该会话因超时自动关闭。');
    end if;

    -- 两条消息而不是一条：客服那份还带着「已计入超时率」，对用户不可见（visible_to_user=false），
    -- 否则用户会看到内部口径。format 用 plain——这两段是管理员填的配置文本，不是谁写的 Markdown。
    insert into public.cs_messages (session_id, sender_role, body, format, visible_to_user)
    values (s.id, 'system', v_user_text,  'plain', true),
           (s.id, 'system', v_agent_text, 'plain', false);

    -- actor_group 留空是和 JS 那条路径（logEvent 的 actor 为 null）逐字一致，好让 §2.13 的统计只认
    -- 一种形状；「是谁关的」放在 detail.source 里，那是加法，不改已有字段的含义。
    insert into public.cs_session_events (session_id, kind, actor_id, actor_group, detail)
    values (s.id, 'timeout_closed', null, '',
            jsonb_build_object('channel', s.channel, 'source', 'pg_cron'));

    v_closed := v_closed + 1;
  end loop;
  return v_closed;
end $$;
revoke all on function private.cs_close_idle_sessions(integer) from public;

-- §2.4/§2.5 心跳失联自动下线。online 是人工开关，last_heartbeat 是活着的证据，真正的「在线」是两者
-- 都成立（见 schema.sql 里 cs_agents 那段）；这个任务负责把只剩开关的那一半收掉。
--
-- 为什么还需要它：shared/cs.mjs 的 pickAgent 已经会跳过心跳过期的人，所以派单本来就不会分给他们。
-- 但 §2.12 给用户看的「当前有没有客服在线」、工作台上的同事状态、以及客服自己看到的那个开关，读的都是
-- online 这一列——浏览器被直接杀掉的客服会一直显示在线，用户于是等在一个没人的会话里，而不是当场看到
-- 兜底文案。所以这一列必须自己变成假的。
--
-- last_heartbeat is null 也算失联：正常路径（cs-session 的 presence）上线时一定会写心跳，所以 null 只
-- 可能来自手工改库，而那时「有开关没证据」应当判定为不在线。
--
-- 只翻开关，不动他手上的会话。把会话一起退回队列是另一个决定（用户会看到接待人突然换掉），而心跳中断
-- 最常见的原因是刷新页面。
create or replace function private.cs_offline_stale_agents()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_seconds integer := coalesce(private.setting_num('cs_heartbeat_timeout_seconds', 90), 90)::integer;
  v_count integer := 0;
begin
  if v_seconds <= 0 then return 0; end if;
  with stale as (
    update public.cs_agents
       set online = false, updated_at = now()
     where online
       and (last_heartbeat is null or last_heartbeat < now() - make_interval(secs => v_seconds))
    returning user_id
  ) select count(*) into v_count from stale;
  return v_count;
end $$;
revoke all on function private.cs_offline_stale_agents() from public;

-- §9.8/§11 站内信自动归档。notification_auto_archive_days 为 0 表示永不自动归档。
--
-- 待处理的（state='pending'）一条都不归档。§9.6 要求它一直挡在眼前，而归档正好是「让它不再挡在眼前」
-- ——自动归档掉一条等着人批的退款，等于给强制置顶开了一个会随时间自动触发的后门。
-- api/_routes/notifications.mjs 的手动归档对同一条件直接回 409，两边判的是同一个 state。
--
-- 归档是每人一份的（notification_receipts 上的 archived_at），所以这里分两步：
--   1. 已经有回执的行，盖上归档时间；
--   2. 点对点通知（scope='user'）如果那个人从来没碰过它，补一行回执。收件人是确定的一个人，补得起。
-- 广播通知没有第二步：scope='admin'/'cs'/'all' 的受众是一个随时间变化的角色，给当时的每个成员各写一行
-- 回执，既会在 scope='all' 上按用户数乘出一张大表，又把受众冻结在跑任务的那一刻。所以广播只归档已经
-- 有回执的人——没打开过的旧广播会留在收件箱里，这是有意的取舍，不是漏写。
create or replace function private.notifications_auto_archive()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_days integer := coalesce(private.setting_num('notification_auto_archive_days', 0), 0)::integer;
  v_cut timestamptz;
  v_touched integer := 0;
  v_added integer := 0;
begin
  if v_days <= 0 then return 0; end if;
  v_cut := now() - make_interval(days => v_days);

  with archived as (
    update public.notification_receipts r
       set archived_at = now()
     where r.archived_at is null
       and exists (
         select 1 from public.notifications n
          where n.id = r.notification_id
            and n.created_at < v_cut
            and n.state is distinct from 'pending')
    returning 1
  ) select count(*) into v_touched from archived;

  -- 不写 read_at：归档不等于读过。未读的旧通知归档之后不再计入角标（收件箱的未读数只数没归档的），
  -- 但它在归档列表里仍然是未读——把它标成已读会让「我从没看过这条」变成一句假话。
  with created as (
    insert into public.notification_receipts (notification_id, user_id, archived_at)
    select n.id, n.recipient_id, now()
      from public.notifications n
     where n.scope = 'user' and n.recipient_id is not null
       and n.created_at < v_cut
       and n.state is distinct from 'pending'
    on conflict (notification_id, user_id) do nothing
    returning 1
  ) select count(*) into v_added from created;

  return v_touched + v_added;
end $$;
revoke all on function private.notifications_auto_archive() from public;

-- §10.5 审批超时升级与重复提醒。shared/notifications.mjs 的 refundEscalationNotification 是同一条通知的
-- JS 版本，到今天为止没有任何调用方——这个任务就是它的调用方，只是用 SQL 又写了一遍（理由见文件开头）。
--
-- 超时本身不改 status。退款是钱的事，不能因为没人看就自动过或自动拒（site_settings 里那条配置的注释
-- 写的就是这件事），所以这里只写 escalated_at / reminded_at 两个时间戳、发通知、留审计。
--
-- 每次都发一条新通知，不是改原来那条的标题：「未读」是按通知算的，原地改标题的话，已经读过原通知的
-- 管理员不会再收到任何提示，而超时提醒的全部意义就是提示那个看过但没处理的人。
--
-- refund_auto_notify 这个开关管不到这里。它的描述是「给用户发」，而这条是发给全体管理员的审批请求本身
-- ——用一个用户通知开关静默掉审批流程，是那种要等到有人问「这笔退款怎么放了两周」才会发现的错。
create or replace function private.refunds_escalate_pending(p_limit integer default 200)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_timeout  integer := coalesce(private.setting_num('refund_approval_timeout_hours', 48), 48)::integer;
  v_interval integer := coalesce(private.setting_num('refund_reminder_interval_hours', 24), 24)::integer;
  v_sent integer := 0;
  v_first boolean;
  v_hours integer;
  v_no text;
  v_amount text;
  r record;
begin
  if v_timeout <= 0 then return 0; end if;

  for r in
    -- 第一次升级：escalated_at 还是空。之后的重复提醒：距上次提醒够久了。间隔为 0 表示只升级一次、
    -- 不重复提醒，所以那时第二个分支整条不成立——读成 0 小时间隔的话，这个任务每跑一次就轰炸一遍。
    select id, order_id, amount_minor, currency, created_at, escalated_at, reminded_at
      from public.refund_requests
     where status = 'pending'
       and created_at < now() - make_interval(hours => v_timeout)
       and (escalated_at is null
            or (v_interval > 0
                and coalesce(reminded_at, escalated_at) < now() - make_interval(hours => v_interval)))
     order by created_at
     limit p_limit
  loop
    v_first := r.escalated_at is null;
    -- 用「已等待多少小时」而不是配置里的阈值：第一次升级时两者差不多，但第三次提醒时说「已超时 48
    -- 小时」是假话，而正文里那句「已等待 X 小时未处理」正是管理员判断该不该插队处理的依据。
    v_hours := floor(extract(epoch from (now() - r.created_at)) / 3600)::integer;
    v_no := private.order_no(r.order_id);
    v_amount := private.format_minor(r.amount_minor, r.currency);

    -- 先打时间戳，再发通知。反过来的话，函数在两句之间失败会让下一次运行重发同一条提醒；而现在的
    -- 顺序在同样情况下是漏一次提醒——两者都不好，但重复轰炸会让人开始忽略这类通知。
    -- 再判一次 status='pending'：上面那个查询是快照，这一瞬间管理员可能刚好点了批准。
    update public.refund_requests
       set escalated_at = coalesce(escalated_at, now()), reminded_at = now(), updated_at = now()
     where id = r.id and status = 'pending';
    if not found then continue; end if;
    -- 这一行必须和 shared/notifications.mjs 的 refundEscalationNotification 加 presentationFor 产出的
    -- 行一致：kind/scope/state/两个按钮，以及 pinned+highlighted。那两个布尔在 JS 侧是算出来的
    -- （state='pending' 且带管理员专属动作 ⇒ 置顶高亮），这里是唯一的插入口，所以直接写成 true——
    -- 落成 schema 默认的 false，表现是一条等着人批的退款躺在列表中间，而不是任何报错。
    -- 只有批准和拒绝两个按钮，没有转交：原通知上已经有转交了，催办要的是「这件事现在办掉」。
    insert into public.notifications
      (kind, scope, recipient_id, title, body, state, pinned, highlighted, refund_id, actions)
    values (
      'refund_approval', 'admin', null,
      format('退款审批已超时 %s 小时：订单 %s', v_hours, v_no),
      format('订单 %s 的 %s 退款申请已等待 %s 小时未处理，请尽快审批。', v_no, v_amount, v_hours),
      'pending', true, true, r.id,
      jsonb_build_array(
        jsonb_build_object('type', 'approve_refund', 'label', '批准退款 ' || v_amount, 'target', r.id),
        jsonb_build_object('type', 'reject_refund',  'label', '拒绝',                  'target', r.id)));

    -- §10.8 的审计。action 用 escalate / remind 两个字面量，AdminRefunds.vue 的 ACTION_LABEL 里为它们
    -- 留了中文；actor_id 为空、actor_group 留空，和别处的系统写入同一种形状（导出时那一列显示「系统」）。
    -- from_status/to_status 都留空是因为状态确实没变——写成 pending→pending 会让审计看起来发生了一次迁移。
    insert into public.refund_audit_log (refund_id, actor_id, actor_group, action, amount_minor, note)
    values (r.id, null, '', case when v_first then 'escalate' else 'remind' end, r.amount_minor,
            case when v_first
              then format('待审批已满 %s 小时（阈值 %s），已升级并通知全体管理员', v_hours, v_timeout)
              else format('待审批已 %s 小时，距上次提醒满 %s 小时，再次通知全体管理员', v_hours, v_interval)
            end);

    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;
revoke all on function private.refunds_escalate_pending(integer) from public;

-- 排班。先 unschedule 再 schedule：cron.schedule 从 1.4 起会按同名任务覆盖旧的，但这个文件不该去挑
-- pg_cron 的版本。下面这句在没有同名任务时返回 0 行，不报错，所以整个文件仍然可以重复跑。
--
-- 时间是数据库服务器的时区（Supabase 上是 UTC），不是站点访客的时区。这四件事都不是「每天早上给谁
-- 发东西」，所以不需要按本地时间对齐。
select cron.unschedule(jobname) from cron.job
 where jobname in ('cs-close-idle-sessions', 'cs-offline-stale-agents',
                   'notifications-auto-archive', 'refunds-escalate-pending');

-- 每分钟。最短的会话超时是 10 分钟，分钟级足够精确；更疏的排班会让「自动关闭」肉眼可见地迟到，而
-- 用户看到的是一个还开着、但没人再回的会话。
select cron.schedule('cs-close-idle-sessions', '* * * * *',
  $$select private.cs_close_idle_sessions()$$);

-- 每分钟。心跳阈值 90 秒，而标准 cron 最细就是一分钟，所以最坏情况下失联到下线之间有 150 秒。
-- pg_cron 1.5 起支持 '30 seconds' 这种写法，要更快就改这一行；但派单本身已经会跳过心跳过期的人，
-- 这里晚一分钟只影响「在线」那块牌子。
select cron.schedule('cs-offline-stale-agents', '* * * * *',
  $$select private.cs_offline_stale_agents()$$);

-- 每小时的第 23 分钟。升级和提醒的单位都是小时，小时级排班比阈值精细一个量级；挑一个不是 0 的分钟，
-- 是为了不和整点那一堆任务挤在一起。
select cron.schedule('refunds-escalate-pending', '23 * * * *',
  $$select private.refunds_escalate_pending()$$);

-- 每天 04:17（UTC）。归档的单位是天，而这一句会扫一遍旧通知，放在低峰。
select cron.schedule('notifications-auto-archive', '17 4 * * *',
  $$select private.notifications_auto_archive()$$);

-- 不必等排班也能各跑一次，返回值就是这次处理了几条：
--   select private.cs_close_idle_sessions(), private.cs_offline_stale_agents(),
--          private.refunds_escalate_pending(), private.notifications_auto_archive();

-- §14 的 audit_log_retention_days 故意还没有对应的任务，这是本文件唯一有意留下的空缺。它的默认值是 0
-- （永久保留），而真要按天清理，删除必须带一个终态判断：一笔还开着的退款，它的审计流水比它自己先被删
-- 掉的话，事后就没有任何东西能解释那笔钱去哪了。那个判断要先定义订单状态机的终态，值得单独做一次，
-- 而不是顺手加在这里。现在的表现是「把它改成 90 不会真的清理」——不好，但比某天夜里自动删掉一半审计
-- 流水好，而后者是不可逆的。
