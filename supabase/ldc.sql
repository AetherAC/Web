-- Additive installation: run after schema.sql. Re-runnable; never replaces existing settings.
begin;

create table if not exists public.ldc_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  session_id uuid references public.cs_sessions(id) on delete restrict,
  kind text not null check (kind in ('discount','coupon','support')),
  name text not null check (length(name) between 1 and 64),
  ldc_minor integer not null check (ldc_minor between 1 and 100000000),
  benefit jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','declined','paid')),
  provider_trade_no text unique,
  coupon_code text unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consented_at timestamptz,
  paid_at timestamptz,
  check ((kind = 'support') = (session_id is not null)),
  check (status <> 'paid' or (paid_at is not null and provider_trade_no is not null and consented_at is not null))
);
create index if not exists ldc_orders_user_idx on public.ldc_orders(user_id,created_at desc);
create index if not exists ldc_orders_session_idx on public.ldc_orders(session_id,created_at desc);
alter table public.ldc_orders enable row level security;
revoke all on public.ldc_orders from anon,authenticated;
grant all on public.ldc_orders to service_role;

create or replace function public.create_ldc_order(
  p_user uuid, p_actor uuid, p_session uuid, p_kind text, p_name text,
  p_amount integer, p_benefit jsonb, p_ttl integer
) returns public.ldc_orders language plpgsql security invoker set search_path = '' as $$
declare result public.ldc_orders; s public.cs_sessions; actor_group text;
begin
  if p_ttl < 5 or p_ttl > 1440 then raise exception 'Invalid TTL'; end if;
  -- A row lock serializes limits across parallel requests and multiple function instances.
  perform 1 from public.user_profiles where user_id = p_user for update;
  if not found then raise exception 'Missing user profile'; end if;
  if (select count(*) from public.ldc_orders where user_id = p_user and created_at > now() - interval '1 hour') >= 20
    or (select count(*) from public.ldc_orders where user_id = p_user and status = 'pending' and expires_at > now()) >= 5
    then raise exception 'Request limit exceeded'; end if;
  if p_kind = 'support' then
    select * into s from public.cs_sessions where id = p_session for update;
    select group_name::text into actor_group from public.user_profiles where user_id = p_actor;
    if s.id is null or s.user_id <> p_user or s.status <> 'open' or p_user = p_actor
      or coalesce(actor_group,'') not in ('presale','postsale','cs','admin')
      or (s.agent_id is distinct from p_actor and actor_group <> 'admin')
      then raise exception 'Session access denied' using errcode = '42501'; end if;
  elsif p_actor <> p_user then raise exception 'Invalid owner' using errcode = '42501';
  end if;
  insert into public.ldc_orders(user_id,requested_by,session_id,kind,name,ldc_minor,benefit,expires_at)
    values(p_user,p_actor,p_session,p_kind,p_name,p_amount,p_benefit,now() + make_interval(mins => p_ttl))
    returning * into result;
  if p_kind = 'support' then
    insert into public.cs_messages(session_id,sender_id,sender_role,body,format)
      values(p_session,p_actor,'system','LDC request: ' || p_name || ' | ' || (p_amount::numeric / 100)::text ||
        ' LDC | ' || result.id::text || ' | Requires your confirmation in the LDC panel.','plain');
    update public.cs_sessions set last_activity_at = now(), updated_at = now() where id = p_session;
  end if;
  return result;
end $$;
revoke all on function public.create_ldc_order(uuid,uuid,uuid,text,text,integer,jsonb,integer) from public,anon,authenticated;
grant execute on function public.create_ldc_order(uuid,uuid,uuid,text,text,integer,jsonb,integer) to service_role;

create or replace function public.complete_ldc_order(p_order uuid, p_trade text)
returns public.ldc_orders language plpgsql security invoker set search_path = '' as $$
declare o public.ldc_orders; code text; conditions jsonb; discount integer; days integer;
begin
  select * into o from public.ldc_orders where id = p_order for update;
  if o.id is null or o.consented_at is null or p_trade is null or p_trade !~ '^[A-Za-z0-9_-]{1,128}$'
    then raise exception 'Invalid settlement'; end if;
  if o.status = 'paid' then
    if o.provider_trade_no <> p_trade then raise exception 'Trade mismatch'; end if;
    return o;
  end if;
  -- Honor a verified late payment, even after local expiry or an administrator disabled LDC.
  if o.kind <> 'support' then
    discount := (o.benefit->>'discount_minor')::integer;
    days := (o.benefit->>'valid_days')::integer;
    if discount is null or discount < 1 or days is null or days not between 1 and 365
      or coalesce(o.benefit->>'currency','') !~ '^[A-Z]{3}$' then raise exception 'Invalid benefit snapshot'; end if;
    code := 'LDC-' || upper(substr(replace(o.id::text,'-',''),1,28));
    conditions := jsonb_build_array(jsonb_build_object('type','amount','op','gte',
      'value',discount,'currency',o.benefit->>'currency'));
    if coalesce(o.benefit->>'sku','') <> '' then
      conditions := conditions || jsonb_build_array(jsonb_build_object('type','sku','op','is','value',o.benefit->>'sku'));
    end if;
    insert into public.coupons(code,name,conditions,actions,starts_at,ends_at,per_user_limit,total_limit,allowed_user_ids)
      values(code,o.name,conditions,jsonb_build_array(jsonb_build_object('type','fixed','value',discount)),
        now(),now() + make_interval(days => days),1,1,array[o.user_id]);
  end if;
  update public.ldc_orders set status = 'paid', provider_trade_no = p_trade, coupon_code = code, paid_at = now()
    where id = o.id returning * into o;
  if o.kind = 'support' then
    insert into public.cs_messages(session_id,sender_role,body,format)
      values(o.session_id,'system','LDC confirmed: ' || o.name || ' | ' || (o.ldc_minor::numeric / 100)::text ||
        ' LDC | ' || o.id::text,'plain');
    update public.cs_sessions set last_activity_at = now(), updated_at = now() where id = o.session_id;
  end if;
  return o;
end $$;
revoke all on function public.complete_ldc_order(uuid,text) from public,anon,authenticated;
grant execute on function public.complete_ldc_order(uuid,text) to service_role;

insert into public.site_settings(key,value,description) values
  ('linuxdo_enabled','{"value":false}'::jsonb,'Linux.DO OAuth login; configure custom:linuxdo in Supabase Auth first'),
  ('ldc_config','{"value":{"enabled":false,"discount_enabled":false,"coupon_enabled":false,"support_enabled":false,"support_max_minor":100000,"request_ttl_minutes":30,"offers":[]}}'::jsonb,'LDC settings; use the Linux.DO / LDC admin page')
on conflict(key) do nothing;

-- Internal provider: never offered as a payable gateway, only used after a server-verified zero quote.
insert into public.payment_providers(id,display_name,enabled,instructions)
values('coupon','Coupon / zero total',false,'Internal zero-total checkout; keep disabled') on conflict(id) do nothing;

create or replace function public.checkout_zero_order(
  p_user uuid, p_artifact uuid, p_coupon uuid, p_code text, p_list integer
) returns public.orders language plpgsql security invoker set search_path = '' as $$
declare a public.artifacts; o public.orders;
begin
  select * into a from public.artifacts where id = p_artifact and active for share;
  if a.id is null or a.price_minor <> p_list or (p_coupon is null and a.price_minor <> 0)
    then raise exception 'Product changed; recheck quote'; end if;
  insert into public.orders(user_id,artifact_id,sku,quantity,amount_minor,currency,provider,
    list_amount_minor,discount_minor,coupon_id,coupon_code,sku_name,sku_description)
    values(p_user,a.id,a.sku,1,0,a.currency,'coupon',a.price_minor,a.price_minor,p_coupon,p_code,a.name,a.description)
    returning * into o;
  if p_coupon is not null and not public.redeem_coupon(p_coupon,p_user,o.id,a.price_minor)
    then raise exception 'Coupon unavailable'; end if;
  update public.orders set status = 'paid', paid_at = now(), paid_amount_minor = 0, paid_currency = a.currency
    where id = o.id returning * into o;
  return o;
end $$;
revoke all on function public.checkout_zero_order(uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.checkout_zero_order(uuid,uuid,uuid,text,integer) to service_role;
commit;
