import { Hono } from "hono";
import { googleCallback, login, logout, passwordLogin, requireAdmin } from "./auth";
import { GOOGLE_CALLBACK_PATH } from "./google-auth";
import { defaultIconResponse, uploadedIconResponse } from "./icon";
import { IMAGE_VARIANT_PARAM, LIMITED_IMAGE_VARIANT, parseImageRequest, publicImageEdge, resizeBounds, serveImage } from "./images";
import { findPhoto, listedGalleries, loadManifest, PHOTO_ID, saveManifest, validateManifest, type Env } from "./manifest";
import { sameOriginWrites, securityHeaders } from "./security";
import { aboutPage, adminPage, galleryPage, homePage, notFoundPage } from "./views";

const app = new Hono<{ Bindings: Env }>();

app.use("*", securityHeaders);
app.use("*", sameOriginWrites);

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const PAGE_CACHE = "public, max-age=60";
const LIMITED_IMAGE_CACHE = "public, max-age=31536000, immutable";
const PUBLIC_IMAGE_CACHE = "public, no-cache";
const BYTES_PER_GB = 1_000_000_000;
const R2_FREE_GB_MONTH = 10;
const R2_USD_PER_GB_MONTH = 0.015;

// ---------- Images ----------

app.get("/img/:id/:file", async (c) => {
  const image = parseImageRequest(c.req.param("id"), c.req.param("file"));
  if (!image) return c.notFound();
  const { id, width, format } = image;
  const manifest = await loadManifest(c.env.BUCKET);
  const photo = findPhoto(manifest, id);
  if (!photo) return c.notFound();

  // Only URLs that always enforce the limit can be cached without revalidation.
  const alwaysLimited = c.req.query(IMAGE_VARIANT_PARAM) === LIMITED_IMAGE_VARIANT;
  const branding = id === manifest.site.logo?.id || id === manifest.site.icon?.id;
  const limit = publicImageEdge(photo, alwaysLimited || (!branding && manifest.site.limitPublicImages !== false));
  const cache = alwaysLimited ? LIMITED_IMAGE_CACHE : PUBLIC_IMAGE_CACHE;
  return serveImage(c.env, c.executionCtx, id, resizeBounds(photo, width, limit), format, cache);
});

// ---------- Site icon ----------
// Linked from every page with ?v=<version>; /favicon.ico is for clients that just guess.

app.get("/favicon.svg", async (c) => defaultIconResponse(await loadManifest(c.env.BUCKET), !!c.req.query("v")));

app.get("/icon.png", async (c) => {
  const m = await loadManifest(c.env.BUCKET);
  if (!m.site.icon) return c.notFound();
  return uploadedIconResponse(c.env, c.executionCtx, m.site.icon.id, !!c.req.query("v"));
});

app.get("/favicon.ico", async (c) => {
  const m = await loadManifest(c.env.BUCKET);
  return m.site.icon
    ? uploadedIconResponse(c.env, c.executionCtx, m.site.icon.id, false)
    : defaultIconResponse(m, false);
});

// ---------- Admin ----------

app.get("/login", login);
app.post("/login", passwordLogin);
app.get(GOOGLE_CALLBACK_PATH, googleCallback);
app.post("/logout", logout);

app.use("/admin", requireAdmin);
app.use("/api/*", requireAdmin);

app.get("/admin", async (c) => {
  // Read the saved site icon for the admin tab.
  const m = await loadManifest(c.env.BUCKET);
  return c.html(adminPage(m), 200, { "Cache-Control": "no-store" });
});

app.get("/api/manifest", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await loadManifest(c.env.BUCKET));
});

app.get("/api/hosting-cost", async (c) => {
  // List object sizes so the estimate includes existing files, cached copies, and trash.
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page: R2Objects = await c.env.BUCKET.list({ cursor });
    for (const object of page.objects) bytes += object.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Project the current storage level over a full month of R2 Standard storage.
  const storageGB = bytes / BYTES_PER_GB;
  const billableGB = Math.max(0, Math.ceil(storageGB) - R2_FREE_GB_MONTH);
  return c.json({ storageGB, monthlyUSD: billableGB * R2_USD_PER_GB_MONTH });
});

app.put("/api/manifest", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  const result = validateManifest(body);
  if (typeof result === "string") return c.json({ error: result }, 422);
  await saveManifest(c.env.BUCKET, result);
  return c.json(result);
});

// The admin can preview a new upload before it is saved in the manifest.
app.get("/api/photos/:id/:file", (c) => {
  const image = parseImageRequest(c.req.param("id"), c.req.param("file"));
  if (!image) return c.notFound();
  return serveImage(c.env, c.executionCtx, image.id, { width: image.width }, image.format, "private, no-store");
});

// Upload one original. Body is the raw file; name travels in X-Filename.
// (Requiring a custom header also means browsers won't send this cross-site.)
app.post("/api/photos", async (c) => {
  const type = (c.req.header("Content-Type") ?? "").split(";")[0].trim();
  if (!ACCEPTED_TYPES.has(type)) return c.json({ error: `Unsupported file type: ${type || "unknown"}` }, 415);
  const rawName = c.req.header("X-Filename");
  if (!rawName) return c.json({ error: "Missing X-Filename header" }, 400);
  if (!c.req.header("Content-Length")) return c.json({ error: "Content-Length required" }, 411);

  let filename = rawName;
  try {
    filename = decodeURIComponent(rawName);
  } catch {}

  const id = newId();
  await c.env.BUCKET.put(`originals/${id}`, c.req.raw.body, {
    httpMetadata: { contentType: type },
    customMetadata: { filename },
  });
  return c.json({ id });
});

// Remove a photo that's no longer in the manifest: original goes to trash/,
// resized copies are deleted.
app.delete("/api/photos/:id", async (c) => {
  const id = c.req.param("id");
  if (!PHOTO_ID.test(id)) return c.json({ error: "Invalid id" }, 400);
  const manifest = await loadManifest(c.env.BUCKET);
  if (findPhoto(manifest, id)) return c.json({ error: "Photo is still in use; save first" }, 409);

  const original = await c.env.BUCKET.get(`originals/${id}`);
  if (original) {
    await c.env.BUCKET.put(`trash/${id}`, original.body, {
      httpMetadata: original.httpMetadata,
      customMetadata: original.customMetadata,
    });
    await c.env.BUCKET.delete(`originals/${id}`);
  }
  const derived = await c.env.BUCKET.list({ prefix: `derived/${id}/` });
  if (derived.objects.length) await c.env.BUCKET.delete(derived.objects.map((o) => o.key));
  return c.body(null, 204);
});

// ---------- Public pages ----------

app.get("/", async (c) => {
  const m = await loadManifest(c.env.BUCKET);
  const origin = new URL(c.req.url).origin;
  // Fall back to the grid if the chosen home gallery is hidden or missing.
  const home = m.site.home ? listedGalleries(m).find((g) => g.slug === m.site.home) : undefined;
  const page = home ? galleryPage(m, home, origin, { isHome: true }) : homePage(m, origin);
  return c.html(page, 200, { "Cache-Control": PAGE_CACHE });
});

app.get("/about", async (c) => {
  const m = await loadManifest(c.env.BUCKET);
  if (!m.about) return c.html(notFoundPage(m), 404);
  return c.html(aboutPage(m, m.about, new URL(c.req.url).origin), 200, { "Cache-Control": PAGE_CACHE });
});

app.get("/:slug", async (c) => {
  const m = await loadManifest(c.env.BUCKET);
  const g = m.galleries.find((g) => g.slug === c.req.param("slug"));
  if (!g) return c.html(notFoundPage(m), 404);
  // Hidden galleries are unlisted, not private: keep a shared link out of search engines.
  const headers: Record<string, string> = { "Cache-Control": PAGE_CACHE };
  if (g.hidden) headers["X-Robots-Tag"] = "noindex, nofollow";
  return c.html(galleryPage(m, g, new URL(c.req.url).origin), 200, headers);
});

app.notFound(async (c) => c.html(notFoundPage(await loadManifest(c.env.BUCKET)), 404));

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default app;
