#!/usr/bin/env node
// Imports a folder of photos from your computer, e.g. albums downloaded from
// Amazon Photos. Each subfolder becomes a gallery (or the folder itself, if it
// holds photos directly). Safe to re-run: photos already in a gallery (same
// file name) are skipped. Close the admin tab while it runs; the admin saves
// its own copy of the site and would overwrite the import.
//
//   SMUGLESS_URL=https://your-site SMUGLESS_PASSWORD=... node scripts/import.mjs ~/Pictures/export
//
// Options:
//   --hidden    create new galleries hidden (unlisted), e.g. a couple's wedding proofs
//   --dry-run   show what would be imported without uploading anything
//
// With Google sign-in there is no password: sign in to /admin in a browser, copy
// the smugless_session cookie and pass SMUGLESS_COOKIE="smugless_session=<value>".

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const MAX_BYTES = 100 * 1024 * 1024;
const PARALLEL_UPLOADS = 3;
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const RESERVED = new Set(["about", "admin", "api", "img", "login", "logout", "static", "vendor", "auth"]);

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const root = args.find((a) => !a.startsWith("--"));
const BASE = process.env.SMUGLESS_URL?.replace(/\/$/, "");
const DRY_RUN = flags.has("--dry-run");
const HIDDEN = flags.has("--hidden");

if (!root || !BASE || (!process.env.SMUGLESS_PASSWORD && !process.env.SMUGLESS_COOKIE && !DRY_RUN)) {
  console.error("Usage: SMUGLESS_URL=... SMUGLESS_PASSWORD=... node scripts/import.mjs <folder> [--hidden] [--dry-run]");
  process.exit(1);
}

// ---------- Reading photos ----------

/** Displayed width/height of a JPEG or PNG, with EXIF orientation applied. */
function imageSize(buf) {
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a JPEG or PNG");
  let orientation = 1;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString("ascii", i + 4, i + 8) === "Exif") orientation = exifOrientation(buf, i + 10) ?? 1;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7);
      return orientation >= 5 ? { w: h, h: w } : { w, h }; // 5–8 rotate by 90°
    }
    i += 2 + len;
  }
  throw new Error("no image size found");
}

function exifOrientation(buf, tiff) {
  const le = buf.toString("ascii", tiff, tiff + 2) === "II";
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = tiff + u32(tiff + 4);
  for (let n = 0, count = u16(ifd); n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
}

function slugify(name) {
  let slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  if (!slug) slug = "gallery";
  return RESERVED.has(slug) ? `${slug}-gallery` : slug;
}

async function photosIn(dir) {
  const names = (await readdir(dir)).filter((n) => !n.startsWith(".") && TYPES[extname(n).toLowerCase()]);
  return names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((n) => join(dir, n));
}

async function findGalleries(dir) {
  const own = await photosIn(dir);
  if (own.length) return [{ title: basename(dir), files: own }];
  const galleries = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const files = await photosIn(join(dir, entry.name));
    if (files.length) galleries.push({ title: entry.name, files });
  }
  return galleries;
}

// ---------- Talking to the site ----------

async function signIn() {
  if (process.env.SMUGLESS_COOKIE) return process.env.SMUGLESS_COOKIE;
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ password: process.env.SMUGLESS_PASSWORD }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("smugless_session="));
  if (res.status !== 303 || !cookie) throw new Error(`Sign-in failed (${res.status})`);
  return cookie.split(";")[0];
}

function client(cookie) {
  return async (path, init = {}) => {
    const res = await fetch(BASE + path, { ...init, headers: { Cookie: cookie, Origin: BASE, ...init.headers } });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
}

async function inParallel(items, limit, fn) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- Main ----------

const galleries = await findGalleries(root);
if (!galleries.length) {
  console.error(`No JPEG or PNG photos found in ${root} or its subfolders`);
  process.exit(1);
}

const api = DRY_RUN ? null : client(await signIn());
const manifest = DRY_RUN ? { galleries: [] } : await api("/api/manifest");
let total = 0;

for (const { title, files } of galleries) {
  const slug = slugify(title);
  let gallery = manifest.galleries.find((g) => g.slug === slug);
  const known = new Set(gallery?.photos.map((p) => p.filename) ?? []);
  const todo = files.filter((f) => !known.has(basename(f)));
  console.log(`${title} → /${slug}: ${todo.length} new of ${files.length}${gallery ? "" : HIDDEN ? " (new, hidden)" : " (new)"}`);
  if (DRY_RUN || !todo.length) continue;

  const uploaded = await inParallel(todo, PARALLEL_UPLOADS, async (file) => {
    const name = basename(file);
    try {
      if ((await stat(file)).size > MAX_BYTES) throw new Error("larger than 100 MB");
      const bytes = await readFile(file);
      const { w, h } = imageSize(bytes);
      const { id } = await api("/api/photos", {
        method: "POST",
        headers: { "Content-Type": TYPES[extname(file).toLowerCase()], "X-Filename": encodeURIComponent(name) },
        body: bytes,
      });
      console.log(`  ✓ ${name} (${w}×${h})`);
      return { id, w, h, filename: name };
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  });

  // Re-read before saving so changes made since the start aren't lost.
  const latest = await api("/api/manifest");
  gallery = latest.galleries.find((g) => g.slug === slug);
  if (!gallery) {
    gallery = { slug, title, photos: [], ...(HIDDEN ? { hidden: true } : {}) };
    latest.galleries.push(gallery);
  }
  const added = uploaded.filter(Boolean);
  gallery.photos.push(...added);
  await api("/api/manifest", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(latest) });
  Object.assign(manifest, latest);
  total += added.length;
}

console.log(DRY_RUN ? "Dry run: nothing uploaded." : `Imported ${total} photos.`);
