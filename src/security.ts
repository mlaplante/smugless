import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./manifest";

// Defense-in-depth hardening that wraps the app: security headers, a check
// against cross-origin writes, sign-in rate limiting and request size limits.

type C = Context<{ Bindings: Env }>;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // Workers request body limit
export const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 255;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Every script and stylesheet is a same-origin file. The one inline style is the
// `style="--r:…"` aspect ratio on gallery tiles, hence style-src-attr.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const COMMON_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const HTML_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Adds security headers to every Worker response (static files get theirs from public/_headers). */
export const securityHeaders: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  let res = c.res;
  try {
    applyHeaders(res.headers, c.req.url);
  } catch {
    // Some responses have immutable headers; copy them into one we can change.
    res = new Response(res.body, res);
    applyHeaders(res.headers, c.req.url);
    c.res = res;
  }
};

function applyHeaders(headers: Headers, url: string) {
  for (const [k, v] of Object.entries(COMMON_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  if (new URL(url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000");
  if ((headers.get("Content-Type") ?? "").startsWith("text/html")) {
    for (const [k, v] of Object.entries(HTML_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  }
}

/**
 * Refuses state-changing requests that a browser sent from another site,
 * including sibling subdomains, which SameSite=Lax cookies treat as same-site.
 * Scripts (no Origin header) are unaffected and still need credentials.
 */
export const sameOriginWrites: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header("Origin");
  const fetchSite = c.req.header("Sec-Fetch-Site");
  const crossOrigin = origin
    ? origin !== new URL(c.req.url).origin
    : fetchSite === "cross-site" || fetchSite === "same-site";
  if (crossOrigin) return c.text("Cross-origin request refused", 403);
  return next();
};

/**
 * Counts one sign-in attempt against the per-IP limit. Every attempt counts, so
 * the limit caps password guesses. Without the LOGIN_LIMITER binding there is no limit.
 */
export async function allowAuthAttempt(c: C): Promise<boolean> {
  const limiter = c.env.LOGIN_LIMITER;
  if (!limiter) return true;
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  try {
    return (await limiter.limit({ key: `auth:${limitKey(ip)}` })).success;
  } catch (err) {
    console.error("rate limiter failed", err);
    return true; // fail open: a limiter outage shouldn't lock the owner out
  }
}

/**
 * Rate-limit key for a client IP: an IPv4 address as is, an IPv6 address by its
 * /64 prefix, since one host or network usually controls a whole /64 and could
 * otherwise rotate addresses to dodge the limit.
 */
export function limitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** HTTP Basic auth for scripts is on unless ADMIN_BASIC_AUTH is "off". */
export function basicAuthEnabled(env: Env): boolean {
  return env.ADMIN_BASIC_AUTH !== "off";
}

/** Short passwords make online guessing practical, so the admin refuses them. */
export function passwordTooShort(password: string): boolean {
  return password.length < MIN_PASSWORD_LENGTH;
}

/** Original upload name for reference only: drop control characters and cap the length. */
export function cleanFilename(name: string): string {
  return [...name.replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, MAX_FILENAME_LENGTH).join("");
}

/** Declared Content-Length, or NaN if missing or malformed. */
export function contentLength(c: C): number {
  const raw = c.req.header("Content-Length");
  return raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
}
