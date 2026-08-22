create extension if not exists pgcrypto;

create table if not exists public.site_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create type public.user_group as enum ('default', 'read', 'coworker', 'admin');
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_name public.user_group not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.site_settings (
  id boolean primary key default true,
  supabase_url text,
  supabase_anon_key text,
  github_api_key text,
  updated_at timestamptz not null default now(),
  constraint only_one_settings check (id)
);
create table if not exists public.repositories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[^/]+/[^/]+$'),
  label text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type public.content_kind as enum ('blog', 'news');
create type public.content_status as enum ('draft', 'published');
create type public.progress_status as enum ('planned', 'active', 'complete', 'paused');

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  kind public.content_kind not null default 'news',
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null,
  summary text not null,
  body text not null,
  cover_url text,
  tags text[] not null default '{}',
  status public.content_status not null default 'draft',
  featured boolean not null default false,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.progress_entries (
  id uuid primary key default gen_random_uuid(),
  stage text not null,
  title text not null,
  summary text not null,
  percent integer not null default 0 check (percent between 0 and 100),
  status public.progress_status not null default 'planned',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists posts_set_updated_at on public.posts;
create trigger posts_set_updated_at before update on public.posts
for each row execute function public.set_updated_at();

drop trigger if exists progress_set_updated_at on public.progress_entries;
create trigger progress_set_updated_at before update on public.progress_entries
for each row execute function public.set_updated_at();

alter table public.site_admins enable row level security;
alter table public.user_profiles enable row level security;
alter table public.site_settings enable row level security;
alter table public.repositories enable row level security;
alter table public.posts enable row level security;
alter table public.progress_entries enable row level security;

create policy "published posts are public" on public.posts
for select using (status = 'published' or exists (select 1 from public.site_admins where user_id = auth.uid()));

create policy "admins manage posts" on public.posts
for all using (exists (select 1 from public.site_admins where user_id = auth.uid()))
with check (exists (select 1 from public.site_admins where user_id = auth.uid()));

create policy "progress is public" on public.progress_entries
for select using (true);

create policy "admins manage progress" on public.progress_entries
for all using (exists (select 1 from public.site_admins where user_id = auth.uid()))
with check (exists (select 1 from public.site_admins where user_id = auth.uid()));

create policy "admins can view admin list" on public.site_admins
for select using (user_id = auth.uid());

create or replace function public.current_user_group() returns public.user_group
language sql stable security definer set search_path = public as $$
  select coalesce((select group_name from public.user_profiles where user_id = auth.uid()), 'default'::public.user_group)
$$;
create policy "profiles self read" on public.user_profiles for select using (user_id = auth.uid() or public.current_user_group() = 'admin');
create policy "admins manage profiles" on public.user_profiles for all using (public.current_user_group() = 'admin') with check (public.current_user_group() = 'admin');
create policy "authenticated read repositories" on public.repositories for select using (auth.uid() is not null);
create policy "admins manage repositories" on public.repositories for all using (public.current_user_group() = 'admin') with check (public.current_user_group() = 'admin');
create policy "admins manage settings" on public.site_settings for all using (public.current_user_group() = 'admin') with check (public.current_user_group() = 'admin');
drop policy if exists "admins manage posts" on public.posts;
create policy "editor manage posts" on public.posts for all using (public.current_user_group() in ('admin','coworker')) with check (public.current_user_group() in ('admin','coworker'));
drop policy if exists "admins manage progress" on public.progress_entries;
create policy "editor manage progress" on public.progress_entries for all using (public.current_user_group() in ('admin','coworker')) with check (public.current_user_group() in ('admin','coworker'));

-- Bootstrap after the administrator has signed in once:
-- insert into public.site_admins (user_id)
-- select id from auth.users where email = 'contact@aetherac.abnt.it'
-- on conflict do nothing;
