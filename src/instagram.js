// Thin client for the Instagram API with Instagram Login (graph.instagram.com).

import { decrypt, encrypt } from "./util.js";

export const API_VERSION = "v26.0";
const DAY = 86400000;

export const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

function hosts(env) {
  // The IG_* overrides exist only so the local test can point at a fake Meta.
  return {
    graphRoot: env.IG_GRAPH_ROOT || "https://graph.instagram.com",
    apiRoot: env.IG_API_ROOT || "https://api.instagram.com",
    authRoot: env.IG_AUTH_ROOT || "https://www.instagram.com",
  };
}

export class IgError extends Error {
  constructor(message, { status, code, subcode, transient } = {}) {
    super(message);
    this.name = "IgError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.transient = Boolean(transient);
  }
}

async function parseResponse(response) {
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  if (response.ok && !body.error) return body;

  const err = body.error || body;
  const message =
    err.error_user_msg ||
    err.message ||
    err.error_message ||
    (typeof body.raw === "string" ? body.raw.slice(0, 300) : "Unknown Instagram API error");
  const code = err.code;
  // 9007 means the media is not ready yet. Rate limits and 5xx are worth retrying too.
  const transient = Boolean(err.is_transient) || response.status >= 500 || [1, 2, 4, 17, 32, 613, 9007].includes(code);
  throw new IgError(`${message} (HTTP ${response.status}${code ? `, code ${code}` : ""}${err.error_subcode ? `, subcode ${err.error_subcode}` : ""})`, {
    status: response.status,
    code,
    subcode: err.error_subcode,
    transient,
  });
}

export async function igGet(env, token, path, params = {}) {
  const url = new URL(`${hosts(env).graphRoot}/${API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set("access_token", token);
  return parseResponse(await fetch(url));
}

export async function igPost(env, token, path, body = {}) {
  const response = await fetch(`${hosts(env).graphRoot}/${API_VERSION}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

export function authorizeUrl(env, { appId, redirectUri, state }) {
  const url = new URL(`${hosts(env).authRoot}/oauth/authorize`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  // Always show the login screen so a second account can be added.
  url.searchParams.set("force_reauth", "true");
  return url.toString();
}

// Code to short-lived token to long-lived token to profile.
export async function exchangeCode(env, { appId, appSecret, redirectUri, code }) {
  const { apiRoot, graphRoot } = hosts(env);
  const form = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const short = await parseResponse(await fetch(`${apiRoot}/oauth/access_token`, { method: "POST", body: form }));
  // Meta documents both a flat object and a { data: [...] } wrapper for this call.
  const shortData = Array.isArray(short.data) ? short.data[0] : short;
  if (!shortData?.access_token) throw new IgError("Instagram did not return an access token.");

  const longUrl = new URL(`${graphRoot}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("access_token", shortData.access_token);
  const long = await parseResponse(await fetch(longUrl));

  const profile = await igGet(env, long.access_token, "me", {
    fields: "user_id,username,name,account_type",
  });
  const permissions = Array.isArray(shortData.permissions)
    ? shortData.permissions.join(",")
    : shortData.permissions || "";
  return {
    token: long.access_token,
    expiresIn: long.expires_in,
    permissions,
    profile,
  };
}

export async function saveAccount(env, result) {
  const now = Date.now();
  const id = String(result.profile.user_id || result.profile.id);
  await env.DB.prepare(
    `INSERT INTO accounts (ig_user_id, username, name, account_type, token_enc, token_expires_at,
       token_refreshed_at, permissions, last_error, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (ig_user_id) DO UPDATE SET username = excluded.username, name = excluded.name,
       account_type = excluded.account_type, token_enc = excluded.token_enc,
       token_expires_at = excluded.token_expires_at, token_refreshed_at = excluded.token_refreshed_at,
       permissions = excluded.permissions, last_error = NULL`,
  )
    .bind(
      id,
      result.profile.username,
      result.profile.name || null,
      result.profile.account_type || null,
      await encrypt(env, result.token),
      now + (result.expiresIn || 60 * 86400) * 1000,
      now,
      result.permissions,
      now,
    )
    .run();
  return { id, username: result.profile.username };
}

export async function accountToken(env, igUserId) {
  const row = await env.DB.prepare("SELECT token_enc FROM accounts WHERE ig_user_id = ?").bind(igUserId).first();
  if (!row) throw new IgError(`Account ${igUserId} is not connected.`);
  return decrypt(env, row.token_enc);
}

// Tokens die after 60 days without a refresh, and must be at least a day old to refresh.
export async function refreshTokens(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT ig_user_id, token_enc, username FROM accounts WHERE token_expires_at < ? AND token_refreshed_at < ?",
  )
    .bind(now + 45 * DAY, now - DAY)
    .all();
  for (const account of results) {
    try {
      const url = new URL(`${hosts(env).graphRoot}/refresh_access_token`);
      url.searchParams.set("grant_type", "ig_refresh_token");
      url.searchParams.set("access_token", await decrypt(env, account.token_enc));
      const fresh = await parseResponse(await fetch(url));
      await env.DB.prepare(
        "UPDATE accounts SET token_enc = ?, token_expires_at = ?, token_refreshed_at = ?, last_error = NULL WHERE ig_user_id = ?",
      )
        .bind(await encrypt(env, fresh.access_token), now + (fresh.expires_in || 60 * 86400) * 1000, now, account.ig_user_id)
        .run();
    } catch (err) {
      await env.DB.prepare("UPDATE accounts SET last_error = ? WHERE ig_user_id = ?")
        .bind(`Token refresh failed: ${err.message}`, account.ig_user_id)
        .run();
    }
  }
}
