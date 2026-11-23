# LaPlante Photography on smugless

This repository is our fork of [akurilin/smugless](https://github.com/akurilin/smugless). It's a photo portfolio that runs on one Cloudflare Worker, a private R2 bucket and Cloudflare Images. There are no servers and no database, and a typical portfolio fits inside Cloudflare's free tiers.

This page covers setting it up, getting photos in from Amazon Photos, staying current with upstream, and the roadmap. The security review is in [SECURITY-REVIEW.md](SECURITY-REVIEW.md).

## What's different from upstream

Fork changes are kept small and mostly in new files, so upstream improvements merge cleanly:

| File | Purpose |
|---|---|
| `src/security.ts` | Security headers, cross-origin write check, sign-in rate limit, upload limits |
| `src/auth.ts`, `src/index.ts`, `src/manifest.ts` | A few lines each to wire that in |
| `public/_headers` | Security headers for static files |
| `wrangler.laplante.jsonc` | Our production Worker, bucket, rate limiter and settings |
| `scripts/import.mjs` | Bulk import from folders on your computer |
| `test/` | Tests (`npm test`) |
| `.github/workflows/ci.yml`, `deploy.yml`, `upstream-sync.yml` | Checks, auto-deploy, weekly upstream sync |

We leave `README.md`, `wrangler.jsonc` and the demo files untouched, because upstream edits them often. Upstream's demo deploy workflow only runs in upstream's repository.

## One-time setup

You need a Cloudflare account (free), Node.js 22+, and ideally the domain on Cloudflare DNS.

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create laplante-photos
npm run deploy:laplante
openssl rand -base64 18 | tr -d '\n' | tee .admin-password | npx wrangler secret put ADMIN_PASSWORD --config wrangler.laplante.jsonc
```

Open `https://laplante-photography.<subdomain>.workers.dev/login` and sign in with the password in `.admin-password`, a git-ignored file.

**Custom domain.** Add the domain to Cloudflare. Then uncomment `routes` in `wrangler.laplante.jsonc`, set the hostname, set `workers_dev` and `preview_urls` to `false`, and deploy.

**Google sign-in (recommended).** Follow the README's "Google sign-in for admins" section, using `--config wrangler.laplante.jsonc` with `wrangler secret put`. Put `ADMIN_AUTH` and `GOOGLE_CLIENT_ID` in the config's `vars`. Store `GOOGLE_CLIENT_SECRET` **and** `GOOGLE_ADMIN_EMAIL` as secrets, because this repository is public.

**Cloudflare Access (recommended).** In Zero Trust → Access → Applications, add a self-hosted app for `yourdomain/admin`, `yourdomain/api/*` and `yourdomain/login`. Allow only your email addresses. This is free for up to 50 users.

**Automatic deploys.** In GitHub → Settings → Environments, create `production` and add:
- secret `CLOUDFLARE_API_TOKEN`, made from the "Edit Cloudflare Workers" token template and limited to your account
- variable `CLOUDFLARE_ACCOUNT_ID`

After that, every merge to `main` runs the typecheck and tests, then deploys. Until the token exists, the deploy job is skipped with a notice.

## Getting photos in from Amazon Photos

Amazon Photos has no public API: Amazon closed the old Amazon Drive developer API, and Amazon Drive itself shut down at the end of 2023. The reliable path is to download, then import:

1. On amazon.com/photos (or in the desktop app), open an album, select the photos and choose **Download**. You get a zip; unzip it into a folder per gallery:
   ```
   ~/Pictures/site-import/
     Dogs/          → /dogs
     Horses/        → /horses
     Smith Wedding/ → /smith-wedding
   ```
2. **Import web exports, not originals.** With the public size limit on (the default), the site never shows more than 1,600 px on the long side. A 45 MB camera JPEG wastes R2 storage. Export JPEGs at about 3000 px on the long edge (1–2 MB each), and 10 GB of free storage then holds several thousand photos. Amazon Photos stays your full-resolution archive.
3. Close any open admin tab, then run:
   ```bash
   SMUGLESS_URL=https://yourdomain SMUGLESS_PASSWORD="$(cat .admin-password)" \
     node scripts/import.mjs ~/Pictures/site-import --dry-run   # preview
   SMUGLESS_URL=https://yourdomain SMUGLESS_PASSWORD="$(cat .admin-password)" \
     node scripts/import.mjs ~/Pictures/site-import
   ```
   Add `--hidden` to create new galleries as unlisted, e.g. a couple's proofs. Re-running skips photos already imported (matched by file name). With Google sign-in, pass `SMUGLESS_COOKIE="smugless_session=…"` from your signed-in browser instead of the password.

The importer accepts JPEG and PNG. HEIC (iPhone) and RAW files must be exported as JPEG first. For a handful of photos, just drag them into the admin.

## Staying current with upstream

Every Monday, **Sync upstream** (`.github/workflows/upstream-sync.yml`) checks `akurilin/smugless`. If there's anything new, it opens or updates a PR from the `upstream-sync` branch into `main`, saying whether the merge is clean. CI tests that PR.

- **Merge it with "Create a merge commit".** Squash or rebase rewrites upstream's commits, and every later sync would conflict.
- Create a fine-grained token for this repository with Contents, Pull requests and Workflows set to read and write, and save it as the `UPSTREAM_SYNC_TOKEN` secret. Without it, upstream changes to `.github/workflows` can't be pushed, and the PR won't trigger CI.
- To sync by hand: `git fetch https://github.com/akurilin/smugless.git main && git merge FETCH_HEAD`, or use GitHub's **Sync fork** button.

**House rule:** put new fork-only behavior in new files, and keep edits to upstream files to a few lines.

## What it costs

| | Free tier | Our likely use |
|---|---|---|
| Workers | 100,000 requests/day | Page views plus image requests. A popular week is a few thousand. |
| R2 | 10 GB | About 5,000 web exports at around 2 MB each |
| Images | 5,000 transformations/month | About 9–12 per new photo, once. Roughly 400 new photos/month free, then $0.50 per 1,000. |

Realistically that's $0/month plus the domain, and $5/month (Workers paid) only if traffic grows a lot.

## Roadmap to the endgame

**Phase 1: this PR (done).** Security hardening, tests, CI, auto-deploy, upstream sync, Amazon Photos import path.

**Phase 2: launch (about a day, mostly configuration).**
- Create the Cloudflare account, bucket, domain, Google sign-in and Cloudflare Access.
- Branding: site title, logo, favicon and About page are all set from the admin.
- Import the first galleries, e.g. Dogs, Cats, Horses, Weddings, Engagements.
- Set up redirects from the current site's URLs, if one exists.

**Phase 3: "near instant" and business features (fork features, in new files).**
- *Edge caching:* serve images and pages from Cloudflare's Cache API, so repeat visits skip R2 entirely. This needs the custom domain.
- *Cache warming:* after an import, request every image variant once, so the first real visitor never waits on a resize.
- *Client galleries:* per-gallery passwords for wedding proofs, with an optional expiry date and a download-all link.
- *Contact or booking form,* plus an inquiry email via Cloudflare Email Routing.
- *Backups:* a scheduled `rclone sync` of the R2 bucket.
- *Save conflict protection* (ETag/If-Match) so two admin tabs can't overwrite each other.

**Decisions we need from you**
1. The domain (and whether its DNS is, or can move, on Cloudflare).
2. Password or Google sign-in for the admin, and which Google account.
3. The starting gallery list, and whether client wedding galleries belong on this site or stay on a delivery service.
