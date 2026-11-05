// End-to-end test against a fake Meta. Starts wrangler dev locally, so nothing
// touches Instagram or the real database. Run with: npm test

import { execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync, writeFileSync } from "node:fs";

const FAKE = 9911;
const PORT = 8799;
const WORKER = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token";

const calls = { publish: [], containers: [] };
const containers = new Map();
let nextId = 1000;

const fake = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fake");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (url.pathname === "/oauth/access_token") return send({ access_token: "short", user_id: 555, permissions: "instagram_business_basic,instagram_business_content_publish" });
  if (url.pathname === "/access_token") return send({ access_token: "long-token", token_type: "bearer", expires_in: 5183944 });
  if (url.pathname.endsWith("/me")) return send({ user_id: "555", username: "testacct", name: "Test", account_type: "BUSINESS" });
  if (url.pathname.endsWith("/555/media") && req.method === "POST") {
    if (req.headers.authorization !== "Bearer long-token") return send({ error: { message: "bad token", code: 190 } }, 401);
    const body = JSON.parse(raw);
    calls.containers.push(body);
    if (body.caption === "reject me") return send({ error: { message: "Invalid image", code: 36003, error_user_msg: "The image is bad." } }, 400);
    const id = String(nextId++);
    const polls = body.media_type === "REELS" ? 2 : 0;
    containers.set(id, { polls, status: body.caption === "fail processing" ? "ERROR" : "FINISHED", published: false });
    return send({ id });
  }
  if (url.pathname.endsWith("/555/media_publish")) {
    const { creation_id } = JSON.parse(raw);
    const c = containers.get(creation_id);
    calls.publish.push(creation_id);
    if (!c || c.published) return send({ error: { message: "Already published", code: 100 } }, 400);
    c.published = true;
    return send({ id: `media_${creation_id}` });
  }
  if (url.pathname.endsWith("/777/comments")) {
    return send({
      data: [{ id: "c1", text: "beautiful", username: "someone", timestamp: "2026-11-02T00:00:00+0000", like_count: 2 }],
      paging: { cursors: { after: "CURSOR" }, next: `https://graph.instagram.com/next?access_token=${req.url.includes("long-token") ? "long-token" : "x"}` },
    });
  }
  if (url.pathname.endsWith("/777/insights")) {
    return send({ data: [{ name: "views", period: "lifetime", values: [{ value: 5000 }] }, { name: "reach", period: "lifetime", values: [{ value: 4000 }] }] });
  }
  if (url.pathname.endsWith("/v26.0/777")) return send({ media_product_type: "REELS", id: "777" });
  if (url.pathname.endsWith("/555/insights")) {
    return send({ data: [{ name: "reach", period: "day", total_value: { value: 123456 } }] });
  }
  const m = url.pathname.match(/\/v26\.0\/(\d+)$/);
  if (m && containers.has(m[1])) {
    const c = containers.get(m[1]);
    if (c.published) return send({ status_code: "PUBLISHED" });
    if (c.polls > 0) {
      c.polls -= 1;
      return send({ status_code: "IN_PROGRESS", status: "working" });
    }
    return send({ status_code: c.status, status: c.status === "ERROR" ? "Video codec not supported" : "done" });
  }
  if (url.pathname.includes("/media_")) return send({ permalink: "https://www.instagram.com/p/FAKE/" });
  if (url.pathname.endsWith("/555/content_publishing_limit")) return send({ data: [{ quota_usage: 1, config: { quota_total: 100 } }] });
  send({ error: { message: `fake has no route for ${req.method} ${url.pathname}` } }, 404);
});
await new Promise((r) => fake.listen(FAKE, "127.0.0.1", r));

rmSync(".wrangler", { recursive: true, force: true });
writeFileSync(".dev.vars", `MCP_TOKEN=${TOKEN}\nENCRYPTION_KEY=test-encryption-key\n`);
execSync("npx wrangler d1 execute instagrammcp --local --file migrations/0001_init.sql", { stdio: "pipe" });

const dev = spawn(
  "npx",
  [
    "wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--test-scheduled",
    "--var", `IG_GRAPH_ROOT:http://127.0.0.1:${FAKE}`,
    "--var", `IG_API_ROOT:http://127.0.0.1:${FAKE}`,
    "--var", `IG_AUTH_ROOT:http://127.0.0.1:${FAKE}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let log = "";
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures += 1;
}
async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${WORKER}/nope`);
      if (r.status === 404) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`wrangler dev never came up:\n${log}`);
}
let rpcId = 1;
async function rpc(method, params = {}) {
  const r = await fetch(`${WORKER}/?bearer_token=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return r.json();
}
async function tool(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { data, isError: Boolean(r.result?.isError) };
}
const cron = () => fetch(`${WORKER}/__scheduled?cron=*+*+*+*+*`);

const IMG = "https://media.test/a.jpg";
const VID = "https://media.test/b.mp4";

// 1x1 JPEG header bytes are enough, since nothing here decodes it.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

try {
  await waitUp();

  const privacy = await fetch(`${WORKER}/privacy`);
  check("privacy page is public", privacy.status === 200 && (await privacy.text()).includes("Privacy Policy"));

  const noAuth = await fetch(`${WORKER}/`, { method: "POST", body: "{}" });
  check("MCP rejects a missing token", noAuth.status === 401);
  const badSetup = await fetch(`${WORKER}/setup?key=wrong`);
  check("setup rejects a wrong key", badSetup.status === 404);

  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  check("initialize", init.result?.serverInfo?.name === "instagrammcp");
  const list = await rpc("tools/list");
  check("tools/list", list.result?.tools?.length === 20, `got ${list.result?.tools?.length}`);

  const early = await tool("ig_post_image", { image_url: "https://x.test/a.jpg" });
  check("posting before an account exists errors", early.isError);

  const save = await fetch(`${WORKER}/setup`, {
    method: "POST",
    body: new URLSearchParams({ key: TOKEN, app_id: "12345", app_secret: "abcdefghijklmnopqrstuvwxyz" }),
  });
  check("setup saves the app", save.status === 200);
  const connect = await fetch(`${WORKER}/connect?key=${TOKEN}`, { redirect: "manual" });
  const authorize = new URL(connect.headers.get("location"));
  check("connect redirects to authorize", authorize.pathname === "/oauth/authorize" && authorize.searchParams.get("force_reauth") === "true");
  const state = authorize.searchParams.get("state");
  const forged = await fetch(`${WORKER}/auth/callback?code=abc&state=forged`);
  check("callback rejects a forged state", forged.status === 400);
  const callback = await fetch(`${WORKER}/auth/callback?code=abc%23_&state=${state}`);
  const callbackText = await callback.text();
  check("callback connects the account", callbackText.includes("@testacct"), callbackText.slice(0, 300));
  const replay = await fetch(`${WORKER}/auth/callback?code=abc&state=${state}`);
  check("callback state is single use", replay.status === 400);

  const accounts = await tool("ig_list_accounts");
  check("account listed", accounts.data[0]?.username === "@testacct", JSON.stringify(accounts.data));
  check("token not exposed", !JSON.stringify(accounts.data).includes("long-token"));

  const upload = await tool("ig_create_upload_url", { filename: "photo.jpg" });
  const put = await fetch(upload.data.upload_url, { method: "PUT", body: JPEG });
  const uploaded = await put.json();
  check("JPEG upload", Boolean(uploaded.media_url), JSON.stringify(uploaded));
  const reuse = await fetch(upload.data.upload_url, { method: "PUT", body: JPEG });
  check("upload link is single use", reuse.status === 404);
  const got = await fetch(uploaded.media_url);
  check("media served", got.status === 200 && got.headers.get("content-type") === "image/jpeg");
  const ranged = await fetch(uploaded.media_url, { headers: { Range: "bytes=2-5" } });
  check("range request", ranged.status === 206 && ranged.headers.get("content-range") === `bytes 2-5/${JPEG.length}`, `${ranged.status} ${ranged.headers.get("content-range")}`);
  const head = await fetch(uploaded.media_url, { method: "HEAD" });
  check("HEAD works", head.status === 200 && head.headers.get("content-length") === String(JPEG.length));

  const notImage = await tool("ig_create_upload_url", { filename: "x.png" });
  const badPut = await fetch(notImage.data.upload_url, { method: "PUT", body: "hello" });
  check("junk upload rejected", badPut.status === 400);

  const video = await tool("ig_create_upload_url", { filename: "clip.mp4" });
  const start = await (await fetch(`${video.data.upload_url}?action=start`, { method: "POST" })).json();
  const part = await (await fetch(`${video.data.upload_url}?upload_id=${encodeURIComponent(start.upload_id)}&part=1`, { method: "PUT", body: Buffer.alloc(1024, 7) })).json();
  const done = await (await fetch(`${video.data.upload_url}?action=complete&upload_id=${encodeURIComponent(start.upload_id)}`, {
    method: "POST",
    body: JSON.stringify({ parts: [part] }),
  })).json();
  check("multipart video upload", done.media_url?.endsWith(".mp4") && done.size === 1024, JSON.stringify(done));

  const image = await tool("ig_post_image", { image_url: IMG, caption: "hello" });
  check("image publishes now", image.data.status === "published" && image.data.permalink, JSON.stringify(image.data));
  check("exactly one publish call", calls.publish.length === 1, String(calls.publish.length));

  const carousel = await tool("ig_post_carousel", { items: [IMG, IMG, { url: VID, type: "video" }], caption: "slides" });
  check("carousel publishes", carousel.data.status === "published", JSON.stringify(carousel.data));
  const parent = calls.containers.find((c) => c.media_type === "CAROUSEL");
  check("carousel parent has 3 children", parent?.children?.split(",").length === 3, JSON.stringify(parent));
  const childVideo = calls.containers.find((c) => c.is_carousel_item && c.video_url);
  check("carousel video child uses media_type VIDEO", childVideo?.media_type === "VIDEO");

  const reel = await tool("ig_post_reel", { video_url: VID, caption: "reel", share_to_feed: true, cover_url: IMG });
  check("reel waits for processing then publishes", reel.data.status === "published", JSON.stringify(reel.data));

  const story = await tool("ig_post_story", { media_url: IMG });
  check("story publishes", story.data.status === "published", JSON.stringify(story.data));
  check("story sent as STORIES", calls.containers.some((c) => c.media_type === "STORIES" && c.image_url));

  const rejected = await tool("ig_post_image", { image_url: IMG, caption: "reject me" });
  check("Meta rejection reported", rejected.isError && rejected.data.status === "failed" && /image is bad/.test(rejected.data.error), JSON.stringify(rejected));
  const processingFail = await tool("ig_post_image", { image_url: IMG, caption: "fail processing" });
  check("processing failure reported", processingFail.isError && /codec/.test(processingFail.data.error), JSON.stringify(processingFail));

  const longCaption = await tool("ig_post_image", { image_url: IMG, caption: "x".repeat(2201) });
  check("long caption refused", longCaption.isError);
  const noOffset = await tool("ig_post_image", { image_url: IMG, publish_at: "2030-01-01T10:00:00" });
  check("publish_at without offset refused", noOffset.isError);
  const past = await tool("ig_post_image", { image_url: IMG, publish_at: "2020-01-01T10:00:00Z" });
  check("past publish_at refused", past.isError);

  const before = calls.publish.length;
  const far = new Date(Date.now() + 3 * 3600000).toISOString();
  const scheduled = await tool("ig_post_image", { image_url: IMG, caption: "later", publish_at: far });
  check("schedule accepted", scheduled.data.status === "queued", JSON.stringify(scheduled.data));
  await cron();
  await new Promise((r) => setTimeout(r, 500));
  const stillQueued = await tool("ig_get_post", { id: scheduled.data.id });
  check("far future post left alone by cron", stillQueued.data.status === "queued" && calls.publish.length === before, stillQueued.data.status);

  const moved = await tool("ig_reschedule_post", { id: scheduled.data.id, publish_at: new Date(Date.now() + 1500).toISOString() });
  check("reschedule", !moved.isError, JSON.stringify(moved.data));
  await new Promise((r) => setTimeout(r, 2000));
  await Promise.all([cron(), cron(), cron(), cron()]);
  await new Promise((r) => setTimeout(r, 1500));
  await cron();
  await new Promise((r) => setTimeout(r, 1000));
  const fired = await tool("ig_get_post", { id: scheduled.data.id });
  check("scheduled post published by cron", fired.data.status === "published", JSON.stringify(fired.data));
  check("racing crons published it once", calls.publish.length === before + 1, `${calls.publish.length - before} publishes`);

  const canceled = await tool("ig_post_image", { image_url: IMG, caption: "nope", publish_at: far });
  const cancel = await tool("ig_cancel_post", { id: canceled.data.id });
  const afterCancel = await tool("ig_get_post", { id: canceled.data.id });
  check("cancel", !cancel.isError && afterCancel.data.status === "canceled");
  const cancelAgain = await tool("ig_cancel_post", { id: fired.data.id });
  check("cancel refused once published", cancelAgain.isError);

  const open = await tool("ig_list_posts", { status: "open" });
  check("no posts left open", Array.isArray(open.data) && open.data.length === 0, JSON.stringify(open.data));
  const failed = await tool("ig_list_posts", { status: "failed" });
  check("failed list", failed.data.length === 2, String(failed.data.length));
  const limit = await tool("ig_publishing_limit");
  check("publishing limit", limit.data.data?.[0]?.config?.quota_total === 100, JSON.stringify(limit.data));

  const comments = await tool("ig_get_comments", { media_id: "777" });
  check("comments read", comments.data.comments?.[0]?.text === "beautiful" && comments.data.next_cursor === "CURSOR", JSON.stringify(comments.data));
  check("comments hide the token", !JSON.stringify(comments.data).includes("long-token"));
  const mediaInsights = await tool("ig_media_insights", { media_id: "777" });
  check("media insights flattened", mediaInsights.data.views === 5000 && mediaInsights.data.reach === 4000, JSON.stringify(mediaInsights.data));
  const accountInsights = await tool("ig_account_insights");
  check("account insights flattened", accountInsights.data.reach === 123456, JSON.stringify(accountInsights.data));

  const status = await tool("ig_setup_status");
  check("setup status", status.data.meta_app_saved === true && status.data.connected_accounts[0] === "@testacct");
  const secretLeak = JSON.stringify(status.data).includes("abcdefghijklmnop");
  check("app secret not exposed", !secretLeak);
} catch (err) {
  console.error(err);
  failures += 1;
} finally {
  try {
    process.kill(-dev.pid);
  } catch {}
  fake.close();
  rmSync(".dev.vars", { force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
