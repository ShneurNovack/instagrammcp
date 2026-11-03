// Every post, immediate or scheduled, runs through this one state machine:
//
//   queued -> preparing -> processing -> publishing -> published
//
// Each transition is a compare-and-swap in D1, so the cron and a live tool call
// can both push the same post without double posting. An Instagram container can
// only be published once, which is the second layer of protection.

import { accountToken, igGet, igPost, IgError } from "./instagram.js";
import { randomId } from "./util.js";

const MINUTE = 60000;
const OPEN = ["queued", "preparing", "processing", "publishing"];
const MAX_ATTEMPTS = 8;
const STUCK_AFTER = 4 * MINUTE;
const GIVE_UP_AFTER = 45 * MINUTE;

// Video needs Meta's transcode, so containers start early enough to go out on time.
function prepareLead(post) {
  const hasVideo = post.items.some((item) => item.type === "video");
  return hasVideo ? 20 * MINUTE : 3 * MINUTE;
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    items: JSON.parse(row.items),
    options: JSON.parse(row.options),
    children: row.children ? JSON.parse(row.children) : [],
  };
}

export async function getPost(env, id) {
  return hydrate(await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first());
}

export async function createPost(env, { igUserId, kind, items, options, publishAt }) {
  const now = Date.now();
  const id = `post_${randomId(9)}`;
  await env.DB.prepare(
    `INSERT INTO posts (id, ig_user_id, kind, items, options, publish_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  )
    .bind(id, igUserId, kind, JSON.stringify(items), JSON.stringify(options), publishAt, now, now)
    .run();
  return id;
}

async function transition(env, id, from, to, fields = {}) {
  const names = Object.keys(fields);
  const sets = names.map((n) => `${n} = ?`).join(", ");
  const sql = `UPDATE posts SET status = ?, updated_at = ?${sets ? `, ${sets}` : ""} WHERE id = ? AND status = ?`;
  const result = await env.DB.prepare(sql)
    .bind(to, Date.now(), ...names.map((n) => fields[n]), id, from)
    .run();
  return result.meta.changes === 1;
}

async function patch(env, id, fields) {
  const names = Object.keys(fields);
  await env.DB.prepare(`UPDATE posts SET ${names.map((n) => `${n} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...names.map((n) => fields[n]), Date.now(), id)
    .run();
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function singleParams(post) {
  const item = post.items[0];
  const o = post.options;
  const shared = { user_tags: o.user_tags, location_id: o.location_id };
  if (post.kind === "image") {
    return compact({
      ...shared,
      image_url: item.url,
      caption: o.caption,
      alt_text: o.alt_text,
      is_ai_generated: o.is_ai_generated,
    });
  }
  if (post.kind === "reel") {
    return compact({
      ...shared,
      media_type: "REELS",
      video_url: item.url,
      caption: o.caption,
      cover_url: o.cover_url,
      thumb_offset: o.thumb_offset,
      share_to_feed: o.share_to_feed,
      audio_name: o.audio_name,
      trial_params: o.trial_graduation ? { graduation_strategy: o.trial_graduation } : undefined,
      is_ai_generated: o.is_ai_generated,
    });
  }
  // Story
  return compact({
    ...shared,
    media_type: "STORIES",
    image_url: item.type === "image" ? item.url : undefined,
    video_url: item.type === "video" ? item.url : undefined,
  });
}

function childParams(item) {
  return compact(
    item.type === "video"
      ? { is_carousel_item: true, media_type: "VIDEO", video_url: item.url }
      : { is_carousel_item: true, image_url: item.url, alt_text: item.alt_text, user_tags: item.user_tags },
  );
}

async function failPost(env, post, from, message) {
  await transition(env, post.id, from, "failed", { error: String(message).slice(0, 1000) });
}

// Back off on a retryable error, or give up after too many tries.
async function retryOrFail(env, post, from, to, err) {
  const attempts = post.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return failPost(env, post, from, err.message);
  await transition(env, post.id, from, to, { attempts, error: String(err.message).slice(0, 1000) });
}

async function prepare(env, post) {
  if (!(await transition(env, post.id, "queued", "preparing"))) return;
  try {
    const token = await accountToken(env, post.ig_user_id);
    if (post.kind === "carousel") {
      const children = [];
      for (const item of post.items) {
        const made = await igPost(env, token, `${post.ig_user_id}/media`, childParams(item));
        children.push(made.id);
      }
      await transition(env, post.id, "preparing", "processing", {
        children: JSON.stringify(children),
        container_id: null,
      });
    } else {
      const made = await igPost(env, token, `${post.ig_user_id}/media`, singleParams(post));
      await transition(env, post.id, "preparing", "processing", { container_id: made.id });
    }
  } catch (err) {
    if (err instanceof IgError && !err.transient) return failPost(env, post, "preparing", err.message);
    await retryOrFail(env, post, "preparing", "queued", err);
  }
}

async function containerStatus(env, token, id) {
  const info = await igGet(env, token, id, { fields: "status_code,status" });
  return { code: info.status_code, detail: info.status };
}

async function finishCarousel(env, post, token) {
  for (const child of post.children) {
    const { code, detail } = await containerStatus(env, token, child);
    if (code === "ERROR" || code === "EXPIRED") {
      const position = post.children.indexOf(child) + 1;
      await failPost(env, post, "processing", `Carousel item ${position} failed: ${detail || code}`);
      return null;
    }
    if (code !== "FINISHED") return null;
  }
  const o = post.options;
  const parent = await igPost(
    env,
    token,
    `${post.ig_user_id}/media`,
    compact({
      media_type: "CAROUSEL",
      children: post.children.join(","),
      caption: o.caption,
      location_id: o.location_id,
      is_ai_generated: o.is_ai_generated,
    }),
  );
  await patch(env, post.id, { container_id: parent.id });
  return parent.id;
}

async function recordPublished(env, post, token, mediaId) {
  let permalink = null;
  if (mediaId) {
    try {
      permalink = (await igGet(env, token, mediaId, { fields: "permalink" })).permalink || null;
    } catch {
      // The post is live either way. A missing link is not worth failing over.
    }
  }
  await transition(env, post.id, "publishing", "published", {
    media_id: mediaId,
    permalink,
    published_at: Date.now(),
    error: null,
  });
}

async function publishWhenReady(env, post) {
  let token;
  try {
    token = await accountToken(env, post.ig_user_id);
    const containerId = post.container_id || (post.kind === "carousel" ? await finishCarousel(env, post, token) : null);
    if (!containerId) return;

    const { code, detail } = await containerStatus(env, token, containerId);
    if (code === "ERROR") return failPost(env, post, "processing", `Instagram rejected the media: ${detail || code}`);
    if (code === "EXPIRED") {
      await transition(env, post.id, "processing", "queued", { container_id: null, children: null });
      return;
    }
    if (code === "PUBLISHED") {
      if (await transition(env, post.id, "processing", "publishing")) await recordPublished(env, post, token, post.media_id);
      return;
    }
    if (code !== "FINISHED" || Date.now() < post.publish_at) return;
    if (!(await transition(env, post.id, "processing", "publishing"))) return;

    let published;
    try {
      published = await igPost(env, token, `${post.ig_user_id}/media_publish`, { creation_id: containerId });
    } catch (err) {
      // A plain network failure stays in "publishing" so recoverStuck can ask Meta what happened.
      if (!(err instanceof IgError)) throw err;
      if (err.transient) return retryOrFail(env, post, "publishing", "processing", err);
      return failPost(env, post, "publishing", err.message);
    }
    await recordPublished(env, post, token, published.id);
  } catch (err) {
    if (err instanceof IgError && !err.transient) return failPost(env, post, "processing", err.message);
    await patch(env, post.id, { error: String(err.message).slice(0, 1000) });
  }
}

async function recoverStuck(env, post) {
  if (Date.now() - post.updated_at < STUCK_AFTER) return;
  if (post.status === "preparing") {
    await transition(env, post.id, "preparing", "queued");
    return;
  }
  if (post.status === "publishing") {
    const token = await accountToken(env, post.ig_user_id);
    const { code, detail } = await containerStatus(env, token, post.container_id);
    if (code === "PUBLISHED") await recordPublished(env, post, token, post.media_id);
    else if (code === "FINISHED") await transition(env, post.id, "publishing", "processing");
    else await failPost(env, post, "publishing", `Publish did not complete: ${detail || code}`);
  }
}

export async function advancePost(env, id) {
  let post = await getPost(env, id);
  if (!post || !OPEN.includes(post.status)) return post;

  if (post.status === "preparing" || post.status === "publishing") {
    await recoverStuck(env, post);
    return getPost(env, id);
  }
  if (post.status === "processing" && Date.now() - post.publish_at > GIVE_UP_AFTER) {
    await failPost(env, post, "processing", post.error || "Timed out waiting for Instagram to process the media.");
    return getPost(env, id);
  }
  if (post.status === "queued") {
    if (Date.now() < post.publish_at - prepareLead(post)) return post;
    await prepare(env, post);
    post = await getPost(env, id);
    if (post.status !== "processing") return post;
  }
  await publishWhenReady(env, post);
  return getPost(env, id);
}

export async function runDuePosts(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id FROM posts WHERE status IN ('queued', 'preparing', 'processing', 'publishing')
     AND publish_at <= ? ORDER BY publish_at LIMIT 8`,
  )
    .bind(now + 20 * MINUTE)
    .all();
  for (const { id } of results) {
    try {
      await advancePost(env, id);
    } catch (err) {
      console.error(`advancePost ${id}: ${err.message}`);
    }
  }
}

export async function cancelPost(env, id) {
  const post = await getPost(env, id);
  if (!post) return { ok: false, reason: "No post with that id." };
  // Past "processing" the publish call may already be on its way.
  for (const from of ["queued", "preparing", "processing"]) {
    if (post.status === from && (await transition(env, id, from, "canceled"))) return { ok: true };
  }
  return { ok: false, reason: `Post is ${(await getPost(env, id)).status}, so it can't be canceled.` };
}

export async function reschedulePost(env, id, publishAt) {
  const result = await env.DB.prepare(
    "UPDATE posts SET publish_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'processing')",
  )
    .bind(publishAt, Date.now(), id)
    .run();
  return result.meta.changes === 1;
}
