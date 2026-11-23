// Test doubles for the Worker bindings. The app runs under Node through Hono's
// app.request(); only what the routes use is implemented.
import { timingSafeEqual } from "node:crypto";
import type { Env } from "../src/manifest";

// Workers adds crypto.subtle.timingSafeEqual; Node has it in node:crypto.
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
if (!subtle.timingSafeEqual) {
  subtle.timingSafeEqual = (a: ArrayBuffer, b: ArrayBuffer) =>
    a.byteLength === b.byteLength && timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

type Stored = { bytes: Uint8Array; httpMetadata?: unknown; customMetadata?: Record<string, string> };

export class MemoryBucket {
  objects = new Map<string, Stored>();

  async put(key: string, value: unknown, opts: { httpMetadata?: unknown; customMetadata?: Record<string, string> } = {}) {
    const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    this.objects.set(key, { bytes, ...opts });
  }

  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      body: new Response(o.bytes).body,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
    };
  }

  async delete(keys: string | string[]) {
    for (const k of [keys].flat()) this.objects.delete(k);
  }

  async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
    const objects = [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.bytes.length }));
    return { objects, truncated: false };
  }
}

export const PASSWORD = "correct-horse-battery-staple";
export const ORIGIN = "https://photos.example";

export function makeEnv(overrides: Partial<Env> = {}): Env & { BUCKET: MemoryBucket } {
  return { BUCKET: new MemoryBucket(), IMAGES: {} as ImagesBinding, ADMIN_PASSWORD: PASSWORD, ...overrides } as never;
}

export function basic(password = PASSWORD) {
  return { Authorization: "Basic " + btoa(`script:${password}`) };
}

/** A limiter that allows `n` attempts in total. */
export function limiter(n: number) {
  let used = 0;
  return { limit: async () => ({ success: used++ < n }) } as RateLimit;
}

export const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
