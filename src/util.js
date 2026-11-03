// Shared helpers: ids, encryption of stored tokens, constant-time compare.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function randomId(bytes = 24) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return toB64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function aesKey(env) {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY secret is not set on the Worker.");
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(env.ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), encoder.encode(plain));
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}

export async function decrypt(env, sealed) {
  const [iv, cipher] = sealed.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await aesKey(env), fromB64(cipher));
  return decoder.decode(plain);
}

// Hash both sides first so the compare never depends on input length.
export async function safeEqual(a, b) {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const p = new Uint8Array(x);
  const q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

export function baseUrl(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

export async function getAppCredentials(env) {
  const [id, sealed] = await Promise.all([getSetting(env, "ig_app_id"), getSetting(env, "ig_app_secret")]);
  if (!id || !sealed) return null;
  return { appId: id, appSecret: await decrypt(env, sealed) };
}
