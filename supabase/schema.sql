create extension if not exists pgcrypto;

create table if not exists public.site_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
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

-- Bootstrap after the administrator has signed in once:
-- insert into public.site_admins (user_id)
-- select id from auth.users where email = 'contact@aetherac.abnt.it'
-- on conflict do nothing;
