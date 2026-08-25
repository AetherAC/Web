# AetherAC deployment

The production topology is intentionally serverless:

```text
aetherac.abnt.it
  -> Cloudflare DNS / proxy
  -> Vercel static VitePress site
     -> /api/github-progress (Vercel Function, server-only GitHub token)
     -> Supabase REST/Auth (Blog, News, roadmap CMS)
```

## 1. Supabase CMS

1. Create a Supabase project.
2. Open **SQL Editor** and run `supabase/schema.sql`.
3. In **Authentication -> URL Configuration**, set:
   - Site URL: `https://aetherac.abnt.it`
   - Redirect URL: `https://aetherac.abnt.it/studio`
4. Copy the Project URL and anon key into the Vercel environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Deploy once, open `/register`, and create the first account for `contact@abnt.it`.
6. After that user exists, execute the bootstrap query at the bottom of `supabase/schema.sql`.

The anon key is public by design. Do not use `service_role` in VitePress or any `VITE_*` variable.

## 2. GitHub progress sync

Create a fine-grained GitHub personal access token with read-only access to:

- Repository metadata
- Issues
- Pull requests (optional for future extensions)

Set these server-only Vercel environment variables:

```text
GITHUB_REPOSITORY=owner/repository
GITHUB_TOKEN=github_pat_...
```

The token is read only by `api/github-progress.mjs`; it is never included in the browser bundle. The endpoint caches successful results for 5 minutes and permits 15 minutes of stale data during revalidation.

## 3. Vercel

1. Push `aetherac-site` to the deployment repository.
2. Import the repository in Vercel.
3. If this site remains inside a monorepo, set **Root Directory** to `aetherac-site`.
4. Add all four environment variables listed above to Production and Preview.
5. Deploy and add `aetherac.abnt.it` in **Settings -> Domains**.

`vercel.json` already configures `npm ci`, the VitePress build, output directory and security/cache headers.

## 4. Cloudflare DNS

Vercel will show the authoritative DNS target for the custom domain. In Cloudflare DNS, add the exact record Vercel requests. For a subdomain this is normally:

```text
Type: CNAME
Name: aetherac
Target: cname.vercel-dns.com
Proxy: DNS only during certificate verification
TTL: Auto
```

After Vercel reports the domain as valid and TLS is active, Cloudflare proxying can be enabled if desired. Set SSL/TLS mode to **Full (strict)** and do not configure a second redirect loop at Cloudflare.

## 5. Local development

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

VitePress local development does not emulate the Vercel Function. Use `vercel dev` when testing `/api/github-progress` locally.
