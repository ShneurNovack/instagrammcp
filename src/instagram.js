// Thin client for the Instagram API with Instagram Login (graph.instagram.com).

import { decrypt, encrypt } from "./util.js";

export const API_VERSION = "v26.0";
const DAY = 86400000;

export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
];

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

// `auth` is a token string (Instagram Login, graph.instagram.com) or { token, root } from accountAuth.
function unpack(env, auth) {
  if (auth && typeof auth === "object") return { token: auth.token, root: auth.root };
  return { token: auth, root: hosts(env).graphRoot };
}

export async function igGet(env, auth, path, params = {}) {
  const { token, root } = unpack(env, auth);
  const url = new URL(`${root}/${API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set("access_token", token);
  return parseResponse(await fetch(url));
}

export async function igPost(env, auth, path, body = {}) {
  const { token, root } = unpack(env, auth);
  const response = await fetch(`${root}/${API_VERSION}/${path}`, {
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

// Token plus the right Graph host for the account's login type.
export async function accountAuth(env, account) {
  const token = await decrypt(env, account.token_enc);
  const root = account.provider === "facebook" ? (env.FB_GRAPH_ROOT || "https://graph.facebook.com") : hosts(env).graphRoot;
  return { token, root };
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
    "SELECT ig_user_id, token_enc, username FROM accounts WHERE provider = 'instagram' AND token_expires_at < ? AND token_refreshed_at < ?",
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


// ---- Facebook Login (graph.facebook.com) ---------------------------------------------------------
// Business Discovery (reading other professional accounts) only exists on this flavor of the API,
// so an account can also be connected through the Facebook Page it is linked to. Page tokens made
// from a long-lived user token don't expire on a timer.

export const FB_SCOPES = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

function fbHosts(env) {
  return {
    graphRoot: env.FB_GRAPH_ROOT || "https://graph.facebook.com",
    authRoot: env.FB_AUTH_ROOT || "https://www.facebook.com",
  };
}

export function fbAuthorizeUrl(env, { appId, redirectUri, state }) {
  const url = new URL(`${fbHosts(env).authRoot}/${API_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", FB_SCOPES.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("auth_type", "rerequest");
  return url.toString();
}

// Code to user token to long-lived user token to one Page token per linked Instagram account.
export async function fbExchangeCode(env, { appId, appSecret, redirectUri, code }) {
  const { graphRoot } = fbHosts(env);
  const graph = (path, params) => {
    const url = new URL(`${graphRoot}/${API_VERSION}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return fetch(url).then(parseResponse);
  };
  const short = await graph("oauth/access_token", { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  const long = await graph("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: short.access_token,
  });
  const accounts = [];
  let after;
  do {
    const page = await graph("me/accounts", {
      fields: "id,name,access_token,instagram_business_account{id,username,name}",
      limit: "100",
      access_token: long.access_token,
      ...(after ? { after } : {}),
    });
    for (const fb of page.data || []) {
      const ig = fb.instagram_business_account;
      if (ig?.username) accounts.push({ ig, pageId: fb.id, pageName: fb.name, token: fb.access_token });
    }
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);
  return accounts;
}

export async function saveFbAccount(env, account) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO accounts (ig_user_id, username, name, account_type, token_enc, token_expires_at, token_refreshed_at,
       permissions, last_error, connected_at, provider, page_id, page_name)
     VALUES (?, ?, ?, 'BUSINESS', ?, ?, ?, ?, NULL, ?, 'facebook', ?, ?)
     ON CONFLICT (ig_user_id) DO UPDATE SET username = excluded.username, name = excluded.name,
       token_enc = excluded.token_enc, token_expires_at = excluded.token_expires_at, token_refreshed_at = excluded.token_refreshed_at,
       permissions = excluded.permissions, last_error = NULL, provider = 'facebook',
       page_id = excluded.page_id, page_name = excluded.page_name`,
  )
    .bind(
      String(account.ig.id),
      account.ig.username,
      account.ig.name || null,
      await encrypt(env, account.token),
      now + 3650 * DAY,
      now,
      FB_SCOPES.join(","),
      now,
      account.pageId,
      account.pageName,
    )
    .run();
  return { id: String(account.ig.id), username: account.ig.username };
}
