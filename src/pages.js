// The few browser pages: saving the Meta app, and the Instagram login flow.
// App credentials go in this form rather than through a chat.

import { authorizeUrl, exchangeCode, saveAccount } from "./instagram.js";
import { baseUrl, encrypt, getAppCredentials, randomId, setSetting } from "./util.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title, body, status = 200) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
  :root { --bg: #fff; --fg: #111; --muted: #666; --line: #bbb; --accent: #111; --accent-fg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #aaa; --line: #555; --accent: #eee; --accent-fg: #111; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 64px 16px; }
  h1 { font-size: 28px; letter-spacing: 0; margin: 0 0 24px; }
  p { color: var(--muted); margin: 0 0 24px; }
  label { display: block; margin: 0 0 8px; font-weight: 600; }
  input { box-sizing: border-box; width: 100%; padding: 12px; margin: 0 0 24px; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 0; }
  button, .button { display: inline-block; padding: 12px 20px; font: inherit; font-weight: 600; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 0; text-decoration: none; cursor: pointer; }
  code { word-break: break-all; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}

export function privacyPage() {
  return page(
    "Privacy Policy",
    `<h1>Privacy Policy</h1>
<p>This is a private publishing tool run by Reshape Creative. It posts content to, and reads comments and insights from, Instagram professional accounts its operator manages. It isn't offered to the public. Last updated November 2, 2026.</p>
<p><strong>What it stores.</strong> For each connected account: the username, account id, an encrypted access token, and the posts scheduled or published through this tool. Media files uploaded for posting are kept for about 14 days, then deleted. Comments and insights are read when the operator requests them and aren't stored by this tool.</p>
<p><strong>How it's used.</strong> Only to publish content and report on the connected accounts. Data isn't sold, used for advertising, or shared with anyone beyond the service providers that run the tool: Cloudflare for hosting, Meta for the Instagram API, and Anthropic, whose assistant Claude the operator uses to work with this data.</p>
<p><strong>Deleting your data.</strong> Remove the app under Apps and websites in your Instagram settings, or email <a href="mailto:hello@reshapecreative.com">hello@reshapecreative.com</a>, and the account's stored data will be deleted.</p>`,
  );
}

export async function setupPage(request, env, key) {
  const origin = baseUrl(request);
  const app = await getAppCredentials(env);
  return page(
    "Instagram MCP setup",
    `<h1>Instagram MCP setup</h1>
<p>Paste the Instagram App ID and Instagram App Secret from your Meta app, under API setup with Instagram login. Add this as the OAuth redirect URI there:<br><code>${esc(origin)}/auth/callback</code></p>
<form method="post" action="/setup">
  <input type="hidden" name="key" value="${esc(key)}">
  <label for="app_id">Instagram App ID</label>
  <input id="app_id" name="app_id" required value="${esc(app?.appId)}" autocomplete="off">
  <label for="app_secret">Instagram App Secret</label>
  <input id="app_secret" name="app_secret" type="password" required autocomplete="off">
  <button type="submit">Save</button>
</form>`,
  );
}

export async function saveSetup(request, env, form) {
  const appId = String(form.get("app_id") || "").trim();
  const appSecret = String(form.get("app_secret") || "").trim();
  if (!/^\d+$/.test(appId) || appSecret.length < 16) {
    return page("Check those values", `<h1>Check those values</h1><p>The App ID should be all digits and the secret should be a long string.</p>`, 400);
  }
  await setSetting(env, "ig_app_id", appId);
  await setSetting(env, "ig_app_secret", await encrypt(env, appSecret));
  const key = esc(form.get("key"));
  return page(
    "Saved",
    `<h1>Saved</h1><p>Now log in to the Instagram account you want to connect.</p><a class="button" href="/connect?key=${key}">Connect an account</a>`,
  );
}

export async function startConnect(request, env) {
  const app = await getAppCredentials(env);
  if (!app) return page("Not set up", `<h1>Not set up</h1><p>Save the Meta app first.</p>`, 400);
  const state = randomId(24);
  await env.DB.prepare("INSERT INTO oauth_states (state, expires_at) VALUES (?, ?)")
    .bind(state, Date.now() + 15 * 60000)
    .run();
  const target = authorizeUrl(env, { appId: app.appId, redirectUri: `${baseUrl(request)}/auth/callback`, state });
  return Response.redirect(target, 302);
}

export async function authCallback(request, env) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (error) return page("Not connected", `<h1>Not connected</h1><p>${esc(error)}</p>`, 400);

  // One use only, and only for a login this server started.
  const state = await env.DB.prepare("DELETE FROM oauth_states WHERE state = ? AND expires_at > ? RETURNING state")
    .bind(url.searchParams.get("state") || "", Date.now())
    .first();
  if (!state) return page("Link expired", `<h1>Link expired</h1><p>Start the connection again.</p>`, 400);

  try {
    const app = await getAppCredentials(env);
    const result = await exchangeCode(env, {
      appId: app.appId,
      appSecret: app.appSecret,
      redirectUri: `${baseUrl(request)}/auth/callback`,
      code: (url.searchParams.get("code") || "").replace(/#_$/, ""),
    });
    const account = await saveAccount(env, result);
    return page("Connected", `<h1>Connected @${esc(account.username)}</h1><p>You can close this tab.</p>`);
  } catch (err) {
    return page("Not connected", `<h1>Not connected</h1><p>${esc(err.message)}</p>`, 400);
  }
}
