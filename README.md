# AetherAC website

VitePress website, public roadmap, Blog/News CMS and GitHub progress sync for AetherAC.

## Local development

```powershell
npm install
npm run dev
```

The site works without external services by using local fallback content. Copy `.env.example` to `.env.local` to connect Supabase.

## Routes

- `/` — product landing page
- `/blog` — engineering articles from Supabase
- `/news` — announcements and release notes from Supabase
- `/progress` — CMS roadmap plus live GitHub progress
- `/studio` — authenticated content editor
- `/login`, `/register` — password, email OTP/link and GitHub OAuth
- `/admin` — Fluent 2 CMS, users, products, payments, repositories, statistics and Vercel environment variables
- `/buy` — authenticated Artifact checkout
- `/me` — account spending and order history
- `/order/{order_id}` — owner-only order detail and refund request
- `/v1/callback/{provider}` — normalized payment callback
- `/api/github-progress` — server-only Vercel Function

## Production

See `DEPLOYMENT.md` for the complete Vercel, Cloudflare, Supabase and GitHub configuration.

```powershell
npm run build
npm run preview
```

Static output is generated in `docs/.vitepress/dist`.

## Required database setup

Run `supabase/schema.sql` in the Supabase SQL editor, enable email confirmation and GitHub Auth, then bootstrap the first admin:

```sql
update public.user_profiles
set group_name = 'admin'
where email = 'contact@abnt.it';
```

The Admin environment editor needs `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID` and, for team-owned projects, `VERCEL_TEAM_ID` to be configured once in Vercel. All remaining runtime and build variables can then be managed in `/admin`; environment changes require a redeployment.
