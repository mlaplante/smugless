import { describe, expect, it } from "vitest";
import app from "../src/index";
import { basic, ctx, limiter, makeEnv, ORIGIN, PASSWORD } from "./helpers";

const req = (path: string, init: RequestInit, env = makeEnv()) => app.request(ORIGIN + path, init, env, ctx);

async function signIn(env = makeEnv(), password = PASSWORD) {
  return req("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ password }),
  }, env);
}

function sessionCookie(res: Response): string {
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0];
}

const manifest = {
  site: { title: "Test Portfolio" },
  galleries: [
    { slug: "dogs", title: "Dogs", photos: [] },
    { slug: "smith-wedding", title: "Smith wedding", hidden: true, photos: [] },
  ],
};

describe("security headers", () => {
  it("sends CSP and anti-framing headers on HTML pages", async () => {
    const res = await req("/", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=\d+/);
  });

  it("sends nosniff but not CSP on non-HTML responses", async () => {
    const res = await req("/favicon.svg", {});
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});

describe("cross-origin writes", () => {
  it("refuses a PUT from another origin even with valid credentials", async () => {
    const res = await req("/api/manifest", {
      method: "PUT",
      headers: { ...basic(), Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a sibling-subdomain request that has no Origin header", async () => {
    const res = await req("/logout", { method: "POST", headers: { "Sec-Fetch-Site": "same-site" } });
    expect(res.status).toBe(403);
  });

  it("allows same-origin browser writes and scripts without Origin", async () => {
    const env = makeEnv();
    const browser = await req("/api/manifest", {
      method: "PUT",
      headers: { ...basic(), Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    }, env);
    expect(browser.status).toBe(200);
    const script = await req("/api/manifest", {
      method: "PUT",
      headers: { ...basic(), "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    }, env);
    expect(script.status).toBe(200);
  });
});

describe("password sign-in", () => {
  it("signs in with the right password and the cookie opens the API", async () => {
    const env = makeEnv();
    const res = await signIn(env);
    expect(res.status).toBe(303);
    const cookie = sessionCookie(res);
    expect(res.headers.get("Set-Cookie")).toMatch(/HttpOnly/i);
    const api = await req("/api/manifest", { headers: { Cookie: cookie } }, env);
    expect(api.status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    expect((await signIn(makeEnv(), "wrong")).status).toBe(401);
  });

  it("stops checking passwords once the rate limit is hit, even the right one", async () => {
    const env = makeEnv({ LOGIN_LIMITER: limiter(2) });
    expect((await signIn(env, "guess-1")).status).toBe(401);
    expect((await signIn(env, "guess-2")).status).toBe(401);
    expect((await signIn(env)).status).toBe(429);
  });

  it("disables the admin when the password is too short", async () => {
    const env = makeEnv({ ADMIN_PASSWORD: "short" });
    expect((await signIn(env, "short")).status).toBe(503);
    expect((await req("/api/manifest", { headers: basic("short") }, env)).status).toBe(503);
  });

  it("rejects a forged session cookie", async () => {
    const forged = `smugless_session=${Math.floor(Date.now() / 1000) + 3600}.AAAA`;
    expect((await req("/api/manifest", { headers: { Cookie: forged } })).status).toBe(401);
  });
});

describe("HTTP Basic auth", () => {
  it("works by default (upstream behaviour)", async () => {
    expect((await req("/api/manifest", { headers: basic() })).status).toBe(200);
  });

  it("can be turned off with ADMIN_BASIC_AUTH=off", async () => {
    const env = makeEnv({ ADMIN_BASIC_AUTH: "off" });
    expect((await req("/api/manifest", { headers: basic() }, env)).status).toBe(401);
  });

  it("counts every attempt toward the rate limit", async () => {
    const env = makeEnv({ LOGIN_LIMITER: limiter(1) });
    expect((await req("/api/manifest", { headers: basic("nope") }, env)).status).toBe(401);
    expect((await req("/api/manifest", { headers: basic() }, env)).status).toBe(429);
  });
});

describe("hidden galleries", () => {
  it("are served but marked noindex; listed galleries are not", async () => {
    const env = makeEnv();
    await env.BUCKET.put("manifest.json", JSON.stringify(manifest));
    const hidden = await req("/smith-wedding", {}, env);
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get("X-Robots-Tag")).toContain("noindex");
    const listed = await req("/dogs", {}, env);
    expect(listed.headers.get("X-Robots-Tag")).toBeNull();
    expect(await (await req("/", {}, env)).text()).not.toContain("smith-wedding");
  });
});

describe("uploads", () => {
  const upload = (headers: Record<string, string>, body: BodyInit = new Uint8Array([0xff, 0xd8, 0xff])) =>
    ({ method: "POST", headers: { ...basic(), "Content-Type": "image/jpeg", ...headers }, body });

  it("refuses bodies declared over 100 MB", async () => {
    const res = await req("/api/photos", upload({ "X-Filename": "a.jpg", "Content-Length": String(101 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("refuses non-image types", async () => {
    const res = await req("/api/photos", upload({ "X-Filename": "a.html", "Content-Length": "3", "Content-Type": "text/html" }));
    expect(res.status).toBe(415);
  });

  it("stores a cleaned, length-capped filename", async () => {
    const env = makeEnv();
    const name = encodeURIComponent("bad\u0000\nname" + "x".repeat(400) + ".jpg");
    const res = await req("/api/photos", upload({ "X-Filename": name, "Content-Length": "3" }), env);
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: string };
    const stored = env.BUCKET.objects.get(`originals/${id}`)!;
    expect(stored.customMetadata!.filename).toMatch(/^badnamex+$/);
    expect(stored.customMetadata!.filename.length).toBe(255);
  });

  it("refuses an oversized manifest", async () => {
    const res = await req("/api/manifest", {
      method: "PUT",
      headers: { ...basic(), "Content-Type": "application/json", "Content-Length": String(6 * 1024 * 1024) },
      body: "{}",
    });
    expect(res.status).toBe(413);
  });
});
