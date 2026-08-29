create extension if not exists pgcrypto;
create schema if not exists private;
drop table if exists public.site_admins cascade;

do $$ begin create type public.user_group as enum ('default','read','coworker','admin'); exception when duplicate_object then null; end $$;
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

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at = now(); return new; end $$;
create or replace function private.current_user_group() returns public.user_group
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select group_name from public.user_profiles where user_id = (select auth.uid())), 'default'::public.user_group)
$$;
revoke all on function private.current_user_group() from public;
grant usage on schema private to authenticated;
grant execute on function private.current_user_group() to authenticated;

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
  foreach t in array array['user_profiles','posts','progress_entries','repositories','site_settings','artifacts','payment_providers','orders','refund_requests']
  loop
    execute format('drop trigger if exists set_updated_at on public.%I',t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',t);
  end loop;
end $$;

do $$ declare t text; begin
  foreach t in array array['user_profiles','posts','progress_entries','repositories','site_settings','artifacts','payment_providers','orders','refund_requests','installation_snapshots']
  loop execute format('alter table public.%I enable row level security',t); end loop;
end $$;
do $$ declare r record; begin
  for r in select policyname,tablename from pg_policies where schemaname='public' and tablename in
    ('user_profiles','posts','progress_entries','repositories','site_settings','artifacts','payment_providers','orders','refund_requests','installation_snapshots')
  loop execute format('drop policy if exists %I on public.%I',r.policyname,r.tablename); end loop;
end $$;

create policy profiles_read on public.user_profiles for select to authenticated
using ((select auth.uid())=user_id or (select private.current_user_group())='admin');
create policy profiles_admin_update on public.user_profiles for update to authenticated
using ((select private.current_user_group())='admin') with check ((select private.current_user_group())='admin');
create policy published_posts_read on public.posts for select to anon,authenticated
using (status='published' or (select private.current_user_group()) in ('read','coworker','admin'));
create policy editor_posts_insert on public.posts for insert to authenticated
with check ((select private.current_user_group()) in ('coworker','admin'));
create policy editor_posts_update on public.posts for update to authenticated
using ((select private.current_user_group()) in ('coworker','admin')) with check ((select private.current_user_group()) in ('coworker','admin'));
create policy editor_posts_delete on public.posts for delete to authenticated
using ((select private.current_user_group()) in ('coworker','admin'));
create policy progress_read on public.progress_entries for select to anon,authenticated using (true);
create policy editor_progress_insert on public.progress_entries for insert to authenticated
with check ((select private.current_user_group()) in ('coworker','admin'));
create policy editor_progress_update on public.progress_entries for update to authenticated
using ((select private.current_user_group()) in ('coworker','admin')) with check ((select private.current_user_group()) in ('coworker','admin'));
create policy editor_progress_delete on public.progress_entries for delete to authenticated
using ((select private.current_user_group()) in ('coworker','admin'));
create policy repositories_read on public.repositories for select to anon,authenticated using (enabled or (select private.current_user_group()) in ('read','coworker','admin'));
create policy repositories_admin_insert on public.repositories for insert to authenticated with check ((select private.current_user_group())='admin');
create policy repositories_admin_update on public.repositories for update to authenticated using ((select private.current_user_group())='admin') with check ((select private.current_user_group())='admin');
create policy repositories_admin_delete on public.repositories for delete to authenticated using ((select private.current_user_group())='admin');
create policy settings_admin on public.site_settings for all to authenticated
using ((select private.current_user_group())='admin') with check ((select private.current_user_group())='admin');
create policy artifacts_read on public.artifacts for select to anon,authenticated using (active or (select private.current_user_group())='admin');
create policy artifacts_admin_insert on public.artifacts for insert to authenticated with check ((select private.current_user_group())='admin');
create policy artifacts_admin_update on public.artifacts for update to authenticated using ((select private.current_user_group())='admin') with check ((select private.current_user_group())='admin');
create policy artifacts_admin_delete on public.artifacts for delete to authenticated using ((select private.current_user_group())='admin');
create policy providers_read on public.payment_providers for select to authenticated using (enabled or (select private.current_user_group())='admin');
create policy providers_admin_insert on public.payment_providers for insert to authenticated with check ((select private.current_user_group())='admin');
create policy providers_admin_update on public.payment_providers for update to authenticated using ((select private.current_user_group())='admin') with check ((select private.current_user_group())='admin');
create policy providers_admin_delete on public.payment_providers for delete to authenticated using ((select private.current_user_group())='admin');
create policy own_orders_read on public.orders for select to authenticated
using ((select auth.uid())=user_id or (select private.current_user_group())='admin');
create policy admin_orders_update on public.orders for update to authenticated
using ((select private.current_user_group())='admin') with check ((select private.current_user_group())='admin');
create policy own_refunds_read on public.refund_requests for select to authenticated
using ((select auth.uid())=user_id or (select private.current_user_group())='admin');
create policy own_refunds_insert on public.refund_requests for insert to authenticated
with check ((select auth.uid())=user_id and exists(select 1 from public.orders o where o.id=order_id and o.user_id=(select auth.uid()) and o.status='paid'));
create policy admin_refunds_update on public.refund_requests for update to authenticated
using ((select private.current_user_group())='admin') with check ((select private.current_user_group())='admin');
create policy install_stats_read on public.installation_snapshots for select to anon,authenticated using (true);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('refund-evidence','refund-evidence',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists refund_evidence_insert on storage.objects;
drop policy if exists refund_evidence_read on storage.objects;
create policy refund_evidence_insert on storage.objects for insert to authenticated
with check(bucket_id='refund-evidence' and (storage.foldername(name))[1]=(select auth.uid()::text));
create policy refund_evidence_read on storage.objects for select to authenticated
using(bucket_id='refund-evidence' and (owner_id=(select auth.uid()::text) or (select private.current_user_group())='admin'));

grant select on public.posts,public.progress_entries,public.repositories,public.artifacts,public.installation_snapshots to anon;
grant select on all tables in schema public to authenticated;
grant insert on public.refund_requests to authenticated;
grant update on public.orders to authenticated;
grant update on public.user_profiles,public.posts,public.progress_entries,public.repositories,public.site_settings,public.artifacts,public.payment_providers,public.refund_requests to authenticated;
grant insert,delete on public.posts,public.progress_entries,public.repositories,public.site_settings,public.artifacts,public.payment_providers to authenticated;

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
('stripe','Stripe','{"driver":"stripe"}'::jsonb,array['STRIPE_SECRET_KEY'],'1. 在 Stripe 控制台 Developers → API keys 取 Secret key（正式环境是 sk_live_ 开头，测试环境 sk_test_ 开头）。2. 在“环境变量”页添加 STRIPE_SECRET_KEY，勾选敏感值。3. 在 Stripe 控制台 Developers → Webhooks 添加端点 https://aetherac.abnt.it/v1/callback/stripe，事件勾选 checkout.session.completed 和 checkout.session.expired；这里不需要 webhook 密钥，回调收到后会反查 Stripe 的会话状态来确认收款。4. 重新部署后回到本页勾选“对外启用”。5. 用 sk_test_ 密钥下一单验证，Stripe 会跳转回 /order/<订单号>。',1),
('paypal','PayPal','{"driver":"paypal","environment":"live"}'::jsonb,array['PAYPAL_CLIENT_ID','PAYPAL_SECRET'],'1. 在 PayPal Developer Dashboard 创建 App，取 Client ID 与 Secret（沙盒和正式是两套）。2. 在“环境变量”页添加 PAYPAL_CLIENT_ID 和 PAYPAL_SECRET，勾选敏感值。3. 要先用沙盒测试就把本行“公开配置”里的 environment 改成 sandbox，正式收款时改回 live。4. 在 App 的 Webhooks 里添加 https://aetherac.abnt.it/v1/callback/paypal，事件勾选 CHECKOUT.ORDER.APPROVED 和 PAYMENT.CAPTURE.COMPLETED；买家批准后由服务端调用 capture 真正扣款，capture 成功才算已付款。5. 重新部署后回到本页勾选“对外启用”。',2),
('payerurl','PayerURL','{"driver":"payerurl"}'::jsonb,array['PAYERURL_PUBLIC_KEY','PAYERURL_SECRET_KEY'],'1. 在 dash.payerurl.com → Profile → Get API credentials 取 Public key 和 Secret key，这两把就是全部凭据，PayerURL 不另发 webhook 密钥。2. 在“环境变量”页添加 PAYERURL_PUBLIC_KEY 和 PAYERURL_SECRET_KEY，勾选敏感值。3. 商户后台没有“回调地址”这一项，不用去找：回调地址（notify_url）随每一笔订单一起发给 PayerURL，本站自动填 https://aetherac.abnt.it/v1/callback/payerurl。回调用同一把 Secret key 做 HMAC-SHA256 校验，所以不需要第三个密钥。4. 重新部署后回到本页勾选“对外启用”。5. 先下一笔小额真单验证：只有 status_code 为 200 且到账金额不低于订单金额时才会标记为已付款；金额不足会被拒绝，仍在链上等确认的会留在“待支付”，等下一次回调再结算。',3)
on conflict(id) do update set
  public_config=excluded.public_config||payment_providers.public_config,
  secret_env_names=excluded.secret_env_names,instructions=excluded.instructions,sort_order=excluded.sort_order;

-- Bootstrap the first administrator after registration:
-- update public.user_profiles set group_name='admin' where email='contact@abnt.it';
