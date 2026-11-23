// The whole site lives in one JSON file in R2. The admin page edits it and
// saves it back whole; the public pages render from it.

export interface Photo {
  id: string;
  w: number; // pixel dimensions of the original, as displayed (orientation applied)
  h: number;
  filename: string; // original upload name, for your reference only
  caption?: string;
}

export interface Gallery {
  slug: string; // becomes the route: /<slug>
  title: string;
  description?: string;
  hidden?: boolean; // hide from public lists while keeping the gallery URL
  cover?: string; // photo id; defaults to the first photo
  photos: Photo[]; // display order
}

// Optional page at /about, linked last in the navigation.
export interface About {
  title: string; // heading and nav label, e.g. "About"
  text: string; // paragraphs separated by blank lines
  email?: string; // shown as a contact link
  photo?: Photo; // portrait, not part of any gallery
}

export interface Manifest {
  // home: slug of a gallery to show at / instead of the grid of all galleries
  // icon: uploaded favicon (not part of any gallery); without it a letter icon is generated
  // logo: uploaded header image; without it the header shows the site title
  site: { title: string; tagline?: string; home?: string; icon?: Photo; logo?: Photo; limitPublicImages?: boolean };
  galleries: Gallery[]; // navigation order
  about?: About;
}

export interface Env {
  BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  ADMIN_AUTH?: string;
  ADMIN_PASSWORD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_ADMIN_EMAIL?: string;
  ADMIN_BASIC_AUTH?: string; // "off" disables HTTP Basic auth for scripts
  LOGIN_LIMITER?: RateLimit; // optional per-IP limit on sign-in attempts
}

const KEY = "manifest.json";

export const PHOTO_ID = /^[a-f0-9]{16}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// Paths the Worker or static assets already use.
const RESERVED = new Set(["about", "admin", "api", "img", "login", "logout", "static", "vendor", "favicon.ico", "robots.txt"]);

export async function loadManifest(bucket: R2Bucket): Promise<Manifest> {
  const obj = await bucket.get(KEY);
  if (!obj) return { site: { title: "Portfolio" }, galleries: [] };
  return obj.json<Manifest>();
}

export async function saveManifest(bucket: R2Bucket, m: Manifest): Promise<void> {
  await bucket.put(KEY, JSON.stringify(m, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

export function listedGalleries(m: Manifest): Gallery[] {
  return m.galleries.filter((g) => !g.hidden);
}

export function findPhoto(m: Manifest, id: string): Photo | undefined {
  if (m.about?.photo?.id === id) return m.about.photo;
  if (m.site.icon?.id === id) return m.site.icon;
  if (m.site.logo?.id === id) return m.site.logo;
  for (const g of m.galleries) {
    const p = g.photos.find((p) => p.id === id);
    if (p) return p;
  }
}

/** Returns a cleaned copy of the manifest, or an error message. */
export function validateManifest(input: unknown): Manifest | string {
  const obj = input as Record<string, any>;
  if (!obj || typeof obj !== "object") return "Manifest must be an object";
  const site = obj.site ?? {};
  if (typeof site.title !== "string" || !site.title.trim()) return "Site title is required";
  if (!Array.isArray(obj.galleries)) return "galleries must be an array";

  const slugs = new Set<string>();
  const ids = new Set<string>();
  const galleries: Gallery[] = [];

  for (const g of obj.galleries) {
    if (typeof g?.title !== "string" || !g.title.trim()) return "Every gallery needs a title";
    if (typeof g.slug !== "string" || !SLUG.test(g.slug))
      return `URL "${g.slug}" for "${g.title}" must be lowercase letters, numbers and dashes`;
    if (RESERVED.has(g.slug)) return `URL "${g.slug}" is reserved; pick another`;
    if (slugs.has(g.slug)) return `Two galleries use the URL "${g.slug}"`;
    slugs.add(g.slug);
    if (!Array.isArray(g.photos)) return `Gallery "${g.title}" has no photo list`;

    const photos: Photo[] = [];
    for (const p of g.photos) {
      const photo = cleanPhoto(p, ids);
      if (typeof photo === "string") return photo;
      photos.push(photo);
    }

    galleries.push({
      slug: g.slug,
      title: g.title.trim(),
      ...(typeof g.description === "string" && g.description.trim() ? { description: g.description } : {}),
      ...(g.hidden === true ? { hidden: true } : {}),
      ...(typeof g.cover === "string" && photos.some((p) => p.id === g.cover) ? { cover: g.cover } : {}),
      photos,
    });
  }

  const icon = site.icon == null ? undefined : cleanPhoto(site.icon, ids);
  if (typeof icon === "string") return icon;
  const logo = site.logo == null ? undefined : cleanPhoto(site.logo, ids);
  if (typeof logo === "string") return logo;

  let about: About | undefined;
  if (obj.about != null) {
    const a = obj.about;
    if (typeof a !== "object") return "about must be an object";
    if (typeof a.title !== "string" || !a.title.trim()) return "The About page needs a title";
    if (typeof a.text !== "string") return "About text must be a string";
    let photo: Photo | undefined;
    if (a.photo != null) {
      const p = cleanPhoto(a.photo, ids);
      if (typeof p === "string") return p;
      photo = p;
    }
    about = {
      title: a.title.trim(),
      text: a.text,
      ...(typeof a.email === "string" && a.email.trim() ? { email: a.email.trim() } : {}),
      ...(photo ? { photo } : {}),
    };
  }

  return {
    site: {
      title: site.title.trim(),
      ...(typeof site.tagline === "string" && site.tagline.trim() ? { tagline: site.tagline } : {}),
      // Only a listed gallery can replace the home page grid.
      ...(galleries.some((g) => g.slug === site.home && !g.hidden) ? { home: site.home } : {}),
      ...(typeof site.limitPublicImages === "boolean" ? { limitPublicImages: site.limitPublicImages } : {}),
      ...(icon ? { icon } : {}),
      ...(logo ? { logo } : {}),
    },
    galleries,
    ...(about ? { about } : {}),
  };
}

/** Checks one photo entry and records its id in `ids` (ids are unique site-wide). */
function cleanPhoto(p: any, ids: Set<string>): Photo | string {
  if (typeof p?.id !== "string" || !PHOTO_ID.test(p.id)) return "Invalid photo id";
  if (ids.has(p.id)) return `Photo ${p.filename ?? p.id} appears twice`;
  ids.add(p.id);
  if (!Number.isInteger(p.w) || !Number.isInteger(p.h) || p.w <= 0 || p.h <= 0)
    return `Photo ${p.filename ?? p.id} has invalid dimensions`;
  return {
    id: p.id,
    w: p.w,
    h: p.h,
    filename: String(p.filename ?? ""),
    ...(typeof p.caption === "string" && p.caption.trim() ? { caption: p.caption } : {}),
  };
}
