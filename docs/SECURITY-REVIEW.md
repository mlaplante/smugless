# Security review: LaPlante Photography fork

**Scope:** all server code (`src/`), the browser code (`public/static/`), scripts, Wrangler config and dependencies, at upstream `akurilin/smugless@d584e54` (November 2026).
**Method:** manual code review, `npm audit`, unit tests that drive the app through Hono's `app.request()` (`test/security.test.ts`), and a local `workerd` run (`wrangler dev`) driven with Chromium to confirm the new headers don't break the admin, galleries or lightbox.

## Summary

The upstream code is small and careful. It had no injection or authentication bypass. Page templates escape every value (`hono/html`), and the admin UI builds the DOM with `createElement` and text nodes, never `innerHTML`. Photo IDs and gallery slugs are regex-validated before they reach R2 keys, so path traversal isn't possible. Password and cookie comparisons are timing-safe. Google sign-in checks state, nonce, PKCE, issuer, audience and `email_verified`. Originals are never served, and resized copies carry no EXIF or GPS data.

The gaps were in **defense in depth**: unlimited password guessing, no browser security headers, writes protected only by SameSite cookies, and unlisted wedding galleries that search engines could index. All of these are fixed in this branch. Most of the code is in one new file, `src/security.ts`, to keep upstream merges easy.

## Fixed in this branch

| # | Severity | Finding | Fix |
|---|---|---|---|
| S1 | Medium | **Unlimited sign-in attempts.** `POST /login`, and HTTP Basic auth on every `/api/*` request, could be tried as fast as the network allows. The only defense was password strength. | Workers Rate Limiting binding `LOGIN_LIMITER`: 10 attempts per minute per IP. Every attempt counts, so a correct guess past the limit is refused too. It fails open if the limiter itself errors, so you can't lock yourself out. |
| S2 | Medium | **No security headers.** The admin could be framed by another site (clickjacking: tricking you into dragging, moving or deleting photos). It had no CSP as a backstop against XSS and no HSTS. | Every Worker response now gets CSP (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`), `X-Frame-Options: DENY`, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and COOP. Static files get theirs from `public/_headers`. Checked in Chromium: no CSP violations in the admin, gallery or lightbox. |
| S3 | Low–Medium | **Writes trusted SameSite alone.** Sibling subdomains count as "same-site", so a compromised `anything.yourdomain.com` could POST to `/logout` or `/login`. | `POST`/`PUT`/`DELETE` are refused if `Origin` (or `Sec-Fetch-Site`) shows another origin. Scripts that send no `Origin` still need credentials. |
| S4 | Low | **HTTP Basic auth was always on**, so the admin password traveled on every script request. | `ADMIN_BASIC_AUTH=off` turns it off; the LaPlante config does so. `scripts/import.mjs` signs in with the form and uses the session cookie instead. Upstream behavior is unchanged when the variable is unset. |
| S5 | Low | **Any password was accepted**, even a 4-character one. | The admin refuses to run with an `ADMIN_PASSWORD` shorter than 12 characters. The README's `openssl rand` command produces 24. |
| S6 | Medium (privacy) | **Hidden galleries were indexable.** "Hidden" means unlisted, but if a couple shared their gallery link publicly, search engines could index the page. | Hidden gallery pages send `X-Robots-Tag: noindex, nofollow`, and the admin and login pages send `noindex`. |
| S7 | Low | **Upload checks.** `Content-Length` was required but not compared with the limit. File names were stored unbounded and could contain control characters, and an oversized name made R2 fail with a 500. | Declared uploads over 100 MB get a 413. Names are stripped of control characters and capped at 255 characters. |
| S8 | Low | **Manifest size unbounded** on `PUT /api/manifest`. | Bodies declared over 5 MB get a 413. A large site's manifest is well under 1 MB. |
| S9 | Info | **Dependencies.** `npm audit` was clean. The first test runner I tried (vitest 3) had critical advisories, so the branch uses vitest 5. | CI runs `npm audit --audit-level=high` on every PR; Dependabot opens grouped weekly updates. |

## Accepted risks, and what would close them

| # | Risk | Why it's acceptable for now | To close it |
|---|---|---|---|
| A1 | Sessions are stateless 30-day HMAC cookies keyed by the password. Logging out clears only that browser's cookie. | Only the owner has a session. Changing the password signs every session out. | **Put `/admin*`, `/api/*` and `/login` behind Cloudflare Access** (free for up to 50 users). Access adds a second login layer that Cloudflare enforces before the Worker even runs. Recommended for production. |
| A2 | Uploaded file types are taken from the `Content-Type` header, without checking the file's magic bytes. | Only an authenticated admin can upload. Originals are never served, only Cloudflare Images output in a fixed format. | Sniff the first bytes before writing to R2. |
| A3 | Hidden galleries are **unlisted, not private**: anyone with the link can see them. | URLs aren't guessable by search engines (now `noindex`), and photo IDs are 64-bit random. | Password-protected client galleries (roadmap, phase 3). |
| A4 | Manifest text fields have no length caps. | Admin-only, and any harm is limited to your own site. | Cap them in `validateManifest`. |
| A5 | Two admin tabs, or the admin plus the importer, overwrite each other: the last save wins. | Data integrity, not security. | `ETag`/`If-Match` on `PUT /api/manifest`. |
| A6 | Deleted photos linger in two places. The original moves to `trash/` in R2, and resized copies may stay in visitors' browser caches (immutable, 1 year). | Expected for a CDN-backed site. | For a client takedown request, also delete `trash/<id>` in the R2 dashboard. |
| A7 | No backups: R2 holds the only copy of uploaded files. | Amazon Photos remains your master archive; the site holds web exports. | Scheduled `rclone sync` of the bucket (roadmap). |

## Operational recommendations

1. Use **Google sign-in** (`ADMIN_AUTH=google`) with the business Google account, and add **Cloudflare Access** on top.
2. Set `GOOGLE_ADMIN_EMAIL` as a **secret**, not a var. This repository is public.
3. After moving to a custom domain, set `"workers_dev": false` and `"preview_urls": false` so there's only one public hostname.
4. Never commit `.dev.vars`, `.admin-password` or Cloudflare tokens; `.gitignore` already excludes them.
5. When you merge an upstream sync, check whether it adds routes. `src/security.ts` runs as global middleware, so new routes are covered automatically, but new admin routes must also sit under `requireAdmin`.
