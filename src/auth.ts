import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { finishGoogleLogin, googleConfig, startGoogleLogin } from "./google-auth";
import type { Env } from "./manifest";
import { allowAuthAttempt, basicAuthEnabled, MIN_PASSWORD_LENGTH, passwordTooShort } from "./security";
import { loginPage } from "./views";

// Admin access: a login form sets a signed session cookie. Scripts can instead
// send the password via HTTP Basic auth (any username) unless ADMIN_BASIC_AUTH is "off". Changing the
// ADMIN_PASSWORD secret invalidates all sessions, since it is the signing key.

const COOKIE = "smugless_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const GOOGLE_AUTH = "google";
const PASSWORD_AUTH = "password";
const UNAUTHORIZED = 401;
const SERVICE_UNAVAILABLE = 503;
const SEE_OTHER = 303;
const TOO_MANY_REQUESTS = 429;
const PASSWORD_TOO_SHORT = `Admin is disabled: ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`;
const GOOGLE_CONFIG_MISSING = "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_ADMIN_EMAIL to enable Google sign-in.";
const enc = new TextEncoder();

type C = Context<{ Bindings: Env }>;

function adminAuth(env: Env): string {
  return env.ADMIN_AUTH ?? PASSWORD_AUTH;
}

export async function login(c: C): Promise<Response> {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  switch (adminAuth(c.env)) {
    case GOOGLE_AUTH: {
      const config = googleConfig(c.env);
      if (!config) return c.text(GOOGLE_CONFIG_MISSING, SERVICE_UNAVAILABLE);
      return startGoogleLogin(c, config);
    }
    case PASSWORD_AUTH:
      return c.html(loginPage());
    default:
      return c.text("Invalid ADMIN_AUTH setting.", SERVICE_UNAVAILABLE);
  }
}

export async function passwordLogin(c: C): Promise<Response> {
  c.header("Cache-Control", "no-store");
  const mode = adminAuth(c.env);
  if (mode === GOOGLE_AUTH) return c.redirect("/login", SEE_OTHER);
  if (mode !== PASSWORD_AUTH) return c.text("Invalid ADMIN_AUTH setting.", SERVICE_UNAVAILABLE);

  const password = c.env.ADMIN_PASSWORD;
  if (password && passwordTooShort(password)) return c.text(PASSWORD_TOO_SHORT, SERVICE_UNAVAILABLE);
  if (!await allowAuthAttempt(c)) {
    return c.html(loginPage("Too many attempts. Wait a minute and try again."), TOO_MANY_REQUESTS);
  }
  const body = await c.req.parseBody();
  if (!password || !await equal(String(body.password ?? ""), password)) {
    return c.html(loginPage("Wrong password"), UNAUTHORIZED);
  }
  return startSession(c, password);
}

export async function googleCallback(c: C): Promise<Response> {
  c.header("Cache-Control", "no-store");
  if (adminAuth(c.env) !== GOOGLE_AUTH) return c.notFound();
  const config = googleConfig(c.env);
  if (!config) return c.text(GOOGLE_CONFIG_MISSING, SERVICE_UNAVAILABLE);
  if (!await finishGoogleLogin(c, config)) {
    return c.text("Google sign-in failed. Open /login and use the configured admin account.", UNAUTHORIZED);
  }
  return startSession(c, config.sessionKey);
}

export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  const isApi = c.req.path.startsWith("/api/");
  switch (adminAuth(c.env)) {
    case GOOGLE_AUTH: {
      const config = googleConfig(c.env);
      if (!config) return c.text(GOOGLE_CONFIG_MISSING, SERVICE_UNAVAILABLE);
      if (await validSession(config.sessionKey, getCookie(c, COOKIE))) return next();
      break;
    }
    case PASSWORD_AUTH: {
      const password = c.env.ADMIN_PASSWORD;
      if (!password) return c.text("Admin is disabled until the ADMIN_PASSWORD secret is set.", SERVICE_UNAVAILABLE);
      if (passwordTooShort(password)) return c.text(PASSWORD_TOO_SHORT, SERVICE_UNAVAILABLE);
      if (await validSession(password, getCookie(c, COOKIE))) return next();
      const basic = await validBasic(password, c);
      if (basic === "limited") return c.json({ error: "Too many attempts" }, TOO_MANY_REQUESTS);
      if (basic === "ok") return next();
      break;
    }
    default:
      return c.text("Invalid ADMIN_AUTH setting.", SERVICE_UNAVAILABLE);
  }

  if (isApi) return c.json({ error: "Not signed in" }, UNAUTHORIZED);
  return c.redirect("/login");
};

async function startSession(c: C, key: string): Promise<Response> {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  const sig = await sign(key, exp);
  setCookie(c, COOKIE, `${exp}.${sig}`, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return c.redirect("/admin", SEE_OTHER);
}

export function logout(c: C): Response {
  deleteCookie(c, COOKIE, { path: "/", secure: true });
  return c.redirect("/", SEE_OTHER);
}

async function validSession(password: string, value?: string): Promise<boolean> {
  const [exp, sig] = (value ?? "").split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return equal(sig, await sign(password, exp));
}

async function validBasic(password: string, c: C): Promise<"ok" | "denied" | "limited"> {
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Basic ") || !basicAuthEnabled(c.env)) return "denied";
  // Every Basic request is a password check, so each one counts toward the limit.
  if (!await allowAuthAttempt(c)) return "limited";
  try {
    const bin = atob(header.slice(6));
    const decoded = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    return (await equal(decoded.slice(decoded.indexOf(":") + 1), password)) ? "ok" : "denied";
  } catch {
    return "denied";
  }
}

async function sign(password: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`smugless-session:${password}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function equal(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
