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
- `/api/github-progress` — server-only Vercel Function

## Production

See `DEPLOYMENT.md` for the complete Vercel, Cloudflare, Supabase and GitHub configuration.

```powershell
npm run build
npm run preview
```

Static output is generated in `docs/.vitepress/dist`.
