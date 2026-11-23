import type { MiddlewareHandler } from "hono";
import type { Env } from "./manifest";

// Hardening that wraps every route: browser security headers and a check that
// state-changing requests come from this site.

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
  try {
    applyHeaders(c.res.headers, c.req.url);
  } catch {
    // Some responses have immutable headers; copy them into one we can change.
    c.res = new Response(c.res.body, c.res);
    applyHeaders(c.res.headers, c.req.url);
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
