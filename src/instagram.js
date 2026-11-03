// Thin client for the Instagram API with Facebook Login (graph.facebook.com).
// New Meta apps no longer offer Instagram Login, so accounts connect through the
// Facebook Page they're linked to, and each stores that Page's token.

import { decrypt, encrypt } from "./util.js";

export const API_VERSION = "v26.0";

export const SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

function hosts(env) {
  // The IG_* overrides exist only so the local test can point at a fake Meta.
  return {
    graphRoot: env.IG_GRAPH_ROOT || "https://graph.facebook.com",
    authRoot: env.IG_AUTH_ROOT || "https://www.facebook.com",
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
  const url = new URL(`${hosts(env).authRoot}/${API_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  // Show the Page picker again, so more accounts can be added later.
  url.searchParams.set("auth_type", "rerequest");
  return url.toString();
}

// Code to user token to long-lived user token to one Page token per Instagram account.
// Page tokens made from a long-lived user token don't expire on a timer.
export async function exchangeCode(env, { appId, appSecret, redirectUri, code }) {
  const { graphRoot } = hosts(env);
  const graph = (path, params) => {
    const url = new URL(`${graphRoot}/${API_VERSION}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return fetch(url).then(parseResponse);
  };

  const short = await graph("oauth/access_token", {
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code,
  });
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

export async function saveAccount(env, account) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO accounts (ig_user_id, username, name, token_enc, token_expires_at, token_refreshed_at,
       page_id, page_name, connected_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT (ig_user_id) DO UPDATE SET username = excluded.username, name = excluded.name,
       token_enc = excluded.token_enc, token_refreshed_at = excluded.token_refreshed_at,
       page_id = excluded.page_id, page_name = excluded.page_name, last_error = NULL`,
  )
    .bind(
      account.ig.id,
      account.ig.username,
      account.ig.name || null,
      await encrypt(env, account.token),
      now,
      account.pageId,
      account.pageName,
      now,
    )
    .run();
  return account.ig.username;
}

export async function accountToken(env, igUserId) {
  const row = await env.DB.prepare("SELECT token_enc FROM accounts WHERE ig_user_id = ?").bind(igUserId).first();
  if (!row) throw new IgError(`Account ${igUserId} is not connected.`);
  return decrypt(env, row.token_enc);
}
