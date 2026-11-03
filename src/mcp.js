// MCP over Streamable HTTP (stateless, JSON responses), same shape as the other
// Workers MCP servers, with hand-written tools instead of generated ones.

import { accountToken, igGet } from "./instagram.js";
import { createUpload, importFromUrl, mediaTypeOfUrl } from "./media.js";
import { advancePost, cancelPost, createPost, getPost, reschedulePost } from "./posts.js";
import { baseUrl, getAppCredentials, sleep } from "./util.js";

const SERVER_INFO = { name: "instagrammcp", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LIVE_WAIT_MS = 40000;
const POLL_MS = 4000;

const INSTRUCTIONS = `Publish and schedule to Zami's Instagram professional accounts through Meta's official API.

Posting is public and goes out under the account's name, so only publish or schedule a post Zami asked for, with the exact media, caption, account, and time he approved. Nothing should go live from Friday afternoon through Saturday night or on Yom Tov, so check the time before scheduling.

To post a local file: call ig_create_upload_url, PUT the file to the returned URL, then pass the returned media_url to a post tool. To post from a link, call ig_import_media first, because Meta often can't fetch share links directly. PNG and WebP become JPEG automatically.

Post tools publish right away unless publish_at is set. A video can take a few minutes to process. If a tool reports the post is still processing, it finishes on its own, so never post it again. Check it with ig_get_post.

Not available through this API: link, poll, and location stickers on stories, adding licensed music, and collab invites (Instagram Login does not support collaborators).`;

const ACCOUNT_PROP = {
  type: "string",
  description: "Username (with or without @) or Instagram user id. Optional when only one account is connected.",
};
const PUBLISH_AT_PROP = {
  type: "string",
  description:
    "When to publish, as ISO 8601 with a UTC offset, like 2026-11-05T10:30:00-05:00. Leave out to publish now.",
};
const USER_TAGS_PROP = {
  type: "array",
  description: "People to tag. x and y run 0 to 1 and are required for images.",
  items: {
    type: "object",
    properties: { username: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
    required: ["username"],
  },
};
const CAPTION_PROP = { type: "string", description: "Up to 2,200 characters, 30 hashtags, and 20 @ tags." };
const AI_PROP = { type: "boolean", description: "Disclose that the media is AI generated." };
const LOCATION_PROP = { type: "string", description: "Facebook Page id of a location." };

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const PUBLISH = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: "ig_setup_status",
    description: "Check setup: whether the Meta app is saved, which accounts are connected, and the setup link.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "ig_connect_account",
    description: "Get the link Zami opens to log in to an Instagram account and connect it.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "ig_list_accounts",
    description: "List connected Instagram accounts and when each token expires.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "ig_disconnect_account",
    description: "Remove a connected account and its stored token. Fails if it has posts still scheduled.",
    inputSchema: { type: "object", properties: { account: ACCOUNT_PROP }, required: ["account"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "ig_create_upload_url",
    description:
      "Create a one-time upload link for a local file. Returns the URL plus curl commands for normal and large files. Images up to 8 MB. Reels up to 300 MB.",
    inputSchema: {
      type: "object",
      properties: { filename: { type: "string", description: "Name ending in .jpg, .png, .webp, .mp4, or .mov." } },
      required: ["filename"],
    },
    annotations: WRITE,
  },
  {
    name: "ig_import_media",
    description:
      "Copy a file from a direct link into this server's storage and return a media_url Meta can fetch. Handles files up to 95 MB and converts PNG and WebP to JPEG.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "https link to the file." } },
      required: ["url"],
    },
    annotations: WRITE,
  },
  {
    name: "ig_post_image",
    description: "Publish or schedule a single-image feed post. Image must be 4:5 to 1.91:1.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        image_url: { type: "string", description: "media_url from an upload or import, or any public JPEG URL." },
        caption: CAPTION_PROP,
        alt_text: { type: "string", description: "Up to 1,000 characters." },
        user_tags: USER_TAGS_PROP,
        location_id: LOCATION_PROP,
        is_ai_generated: AI_PROP,
        publish_at: PUBLISH_AT_PROP,
      },
      required: ["image_url"],
    },
    annotations: PUBLISH,
  },
  {
    name: "ig_post_carousel",
    description:
      "Publish or schedule a carousel of 2 to 20 images and videos. Every slide is cropped to the first slide's aspect ratio.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        items: {
          type: "array",
          minItems: 2,
          maxItems: 20,
          description: "Slides in order. Each is a media_url string, or an object with url, type, and alt_text.",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  url: { type: "string" },
                  type: { type: "string", enum: ["image", "video"] },
                  alt_text: { type: "string" },
                  user_tags: USER_TAGS_PROP,
                },
                required: ["url"],
              },
            ],
          },
        },
        caption: CAPTION_PROP,
        location_id: LOCATION_PROP,
        is_ai_generated: AI_PROP,
        publish_at: PUBLISH_AT_PROP,
      },
      required: ["items"],
    },
    annotations: PUBLISH,
  },
  {
    name: "ig_post_reel",
    description: "Publish or schedule a reel. MP4 or MOV, H.264 or HEVC, AAC audio, 3 seconds to 15 minutes, up to 300 MB.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        video_url: { type: "string", description: "media_url from an upload or import, or any public video URL." },
        caption: CAPTION_PROP,
        cover_url: { type: "string", description: "JPEG cover image, 9:16 recommended." },
        thumb_offset: { type: "integer", description: "Frame to use as cover, in milliseconds. Ignored if cover_url is set." },
        share_to_feed: { type: "boolean", description: "Show in the Feed as well as the Reels tab." },
        audio_name: { type: "string", description: "Name for the reel's original audio. Can only be renamed once." },
        trial_graduation: {
          type: "string",
          enum: ["MANUAL", "SS_PERFORMANCE"],
          description: "Post as a trial reel shown only to non-followers, with this graduation strategy.",
        },
        user_tags: USER_TAGS_PROP,
        location_id: LOCATION_PROP,
        is_ai_generated: AI_PROP,
        publish_at: PUBLISH_AT_PROP,
      },
      required: ["video_url"],
    },
    annotations: PUBLISH,
  },
  {
    name: "ig_post_story",
    description:
      "Publish or schedule a story from one image or video (3 to 60 seconds, up to 100 MB, 9:16). Stickers and link stickers are not available through the API.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        media_url: { type: "string", description: "media_url from an upload or import, or any public URL." },
        media_type: { type: "string", enum: ["image", "video"], description: "Only needed if the URL has no file extension." },
        user_tags: USER_TAGS_PROP,
        publish_at: PUBLISH_AT_PROP,
      },
      required: ["media_url"],
    },
    annotations: PUBLISH,
  },
  {
    name: "ig_get_post",
    description: "Get one post's status, including its permalink once live or the error if it failed.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: READ,
  },
  {
    name: "ig_list_posts",
    description: "List posts made through this server, newest publish time first.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        status: {
          type: "string",
          enum: ["open", "published", "failed", "canceled"],
          description: "open means scheduled or still in progress.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    annotations: READ,
  },
  {
    name: "ig_cancel_post",
    description: "Cancel a post that hasn't gone live yet.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "ig_reschedule_post",
    description: "Move a post that hasn't gone live yet to a new time.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, publish_at: PUBLISH_AT_PROP },
      required: ["id", "publish_at"],
    },
    annotations: WRITE,
  },
  {
    name: "ig_publishing_limit",
    description: "Check how many API posts the account has used in the current rolling 24 hours.",
    inputSchema: { type: "object", properties: { account: ACCOUNT_PROP } },
    annotations: READ,
  },
  {
    name: "ig_recent_media",
    description: "List the account's most recent feed posts and reels, including ones posted in the app.",
    inputSchema: {
      type: "object",
      properties: { account: ACCOUNT_PROP, limit: { type: "integer", minimum: 1, maximum: 50 } },
    },
    annotations: READ,
  },
];

class ToolError extends Error {}

function textResult(data, isError = false) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function resolveAccount(env, value) {
  const { results } = await env.DB.prepare("SELECT * FROM accounts ORDER BY connected_at").all();
  if (!results.length) throw new ToolError("No Instagram accounts are connected yet. Use ig_connect_account.");
  if (!value) {
    if (results.length === 1) return results[0];
    throw new ToolError(`Say which account: ${results.map((a) => `@${a.username}`).join(", ")}.`);
  }
  const wanted = String(value).replace(/^@/, "").toLowerCase();
  const match = results.find((a) => a.username.toLowerCase() === wanted || a.ig_user_id === wanted);
  if (!match) throw new ToolError(`@${wanted} isn't connected. Connected: ${results.map((a) => `@${a.username}`).join(", ")}.`);
  return match;
}

function parsePublishAt(value) {
  if (!value) return { publishAt: Date.now(), scheduled: false };
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new ToolError("publish_at needs a UTC offset, like 2026-11-05T10:30:00-05:00.");
  const publishAt = Date.parse(value);
  if (Number.isNaN(publishAt)) throw new ToolError("publish_at isn't a valid date.");
  if (publishAt < Date.now() - 60000) throw new ToolError("publish_at is in the past.");
  return { publishAt, scheduled: true };
}

function checkUrl(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(`${label} isn't a valid URL.`);
  }
  if (parsed.protocol !== "https:") throw new ToolError(`${label} must be https.`);
}

function checkCaption(caption) {
  if (!caption) return;
  if (caption.length > 2200) throw new ToolError(`Caption is ${caption.length} characters and the limit is 2,200.`);
  const hashtags = (caption.match(/#[^\s#]+/g) || []).length;
  if (hashtags > 30) throw new ToolError(`Caption has ${hashtags} hashtags and the limit is 30.`);
  const mentions = (caption.match(/(^|\s)@[A-Za-z0-9._]+/g) || []).length;
  if (mentions > 20) throw new ToolError(`Caption has ${mentions} @ tags and the limit is 20.`);
}

function slideItem(entry, position) {
  const slide = typeof entry === "string" ? { url: entry } : { ...entry };
  checkUrl(slide.url, `Slide ${position}`);
  slide.type = slide.type || mediaTypeOfUrl(slide.url);
  if (!slide.type) throw new ToolError(`Slide ${position} has no file extension, so set its type to image or video.`);
  return slide;
}

function describe(post, account) {
  return {
    id: post.id,
    account: account ? `@${account.username}` : post.ig_user_id,
    kind: post.kind,
    status: post.status,
    publish_at: new Date(post.publish_at).toISOString(),
    published_at: post.published_at ? new Date(post.published_at).toISOString() : undefined,
    permalink: post.permalink || undefined,
    media_id: post.media_id || undefined,
    error: post.error || undefined,
    slides: post.kind === "carousel" ? post.items.length : undefined,
    caption: post.options.caption ? post.options.caption.slice(0, 120) : undefined,
  };
}

async function submitPost(env, { account, kind, items, options, publish_at }) {
  const acct = await resolveAccount(env, account);
  const { publishAt, scheduled } = parsePublishAt(publish_at);
  checkCaption(options.caption);
  const clean = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const id = await createPost(env, { igUserId: acct.ig_user_id, kind, items, options: clean, publishAt });

  if (scheduled) {
    return textResult({ ...describe(await getPost(env, id), acct), note: "Scheduled. It publishes on its own at publish_at." });
  }

  // Try to finish inside this call. The cron picks up anything that takes longer.
  const deadline = Date.now() + LIVE_WAIT_MS;
  let post = await advancePost(env, id);
  while (post && !["published", "failed", "canceled"].includes(post.status) && Date.now() < deadline) {
    await sleep(POLL_MS);
    post = await advancePost(env, id);
  }
  if (post.status === "failed") return textResult(describe(post, acct), true);
  if (post.status !== "published") {
    return textResult({
      ...describe(post, acct),
      note: "Instagram is still processing this. It publishes automatically when ready, so don't post it again. Check with ig_get_post.",
    });
  }
  return textResult(describe(post, acct));
}

async function runTool(name, args, env, request, origin) {
  const key = env.MCP_TOKEN;
  switch (name) {
    case "ig_setup_status": {
      const app = await getAppCredentials(env);
      const { results } = await env.DB.prepare("SELECT username FROM accounts ORDER BY connected_at").all();
      return textResult({
        meta_app_saved: Boolean(app),
        connected_accounts: results.map((a) => `@${a.username}`),
        setup_page: `${origin}/setup?key=${key}`,
        oauth_redirect_uri: `${origin}/auth/callback`,
      });
    }
    case "ig_connect_account": {
      if (!(await getAppCredentials(env))) {
        throw new ToolError(`The Meta app isn't saved yet. Open ${origin}/setup?key=${key} first.`);
      }
      return textResult({
        connect_link: `${origin}/connect?key=${key}`,
        note: "Open this and log in to the account to connect. Repeat for each account.",
      });
    }
    case "ig_list_accounts": {
      const { results } = await env.DB.prepare("SELECT * FROM accounts ORDER BY connected_at").all();
      return textResult(
        results.map((a) => ({
          username: `@${a.username}`,
          id: a.ig_user_id,
          type: a.account_type,
          permissions: a.permissions,
          token_expires_at: new Date(a.token_expires_at).toISOString(),
          last_error: a.last_error || undefined,
        })),
      );
    }
    case "ig_disconnect_account": {
      const acct = await resolveAccount(env, args.account);
      const open = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM posts WHERE ig_user_id = ? AND status IN ('queued', 'preparing', 'processing', 'publishing')",
      )
        .bind(acct.ig_user_id)
        .first();
      if (open.n) throw new ToolError(`@${acct.username} has ${open.n} open posts. Cancel them first.`);
      await env.DB.prepare("DELETE FROM accounts WHERE ig_user_id = ?").bind(acct.ig_user_id).run();
      return textResult(`Disconnected @${acct.username}.`);
    }
    case "ig_create_upload_url": {
      const upload = await createUpload(env, request, args.filename);
      const file = args.filename.replace(/"/g, "");
      const result = {
        upload_url: upload.uploadUrl,
        expires_in: "2 hours, one use",
        curl: `curl -sS -T "${file}" "${upload.uploadUrl}"`,
        returns: "JSON with media_url. Pass that to a post tool.",
      };
      if (upload.isVideo) {
        result.over_95_mb =
          "Cloudflare caps one request at 100 MB. For bigger files: POST ?action=start for an upload_id, split the file into equal 50 MB parts, PUT each to ?upload_id=ID&part=N (N starts at 1) and keep the returned partNumber and etag, then POST ?action=complete&upload_id=ID with the JSON body {\"parts\":[{\"partNumber\":1,\"etag\":\"...\"}]}.";
      }
      return textResult(result);
    }
    case "ig_import_media":
      return textResult(await importFromUrl(env, request, args.url));
    case "ig_post_image": {
      checkUrl(args.image_url, "image_url");
      return submitPost(env, {
        account: args.account,
        kind: "image",
        items: [{ url: args.image_url, type: "image" }],
        publish_at: args.publish_at,
        options: {
          caption: args.caption,
          alt_text: args.alt_text,
          user_tags: args.user_tags,
          location_id: args.location_id,
          is_ai_generated: args.is_ai_generated,
        },
      });
    }
    case "ig_post_carousel": {
      if (!Array.isArray(args.items) || args.items.length < 2 || args.items.length > 20) {
        throw new ToolError("A carousel needs 2 to 20 items.");
      }
      return submitPost(env, {
        account: args.account,
        kind: "carousel",
        items: args.items.map((entry, i) => slideItem(entry, i + 1)),
        publish_at: args.publish_at,
        options: {
          caption: args.caption,
          location_id: args.location_id,
          is_ai_generated: args.is_ai_generated,
        },
      });
    }
    case "ig_post_reel": {
      checkUrl(args.video_url, "video_url");
      if (args.cover_url) checkUrl(args.cover_url, "cover_url");
      return submitPost(env, {
        account: args.account,
        kind: "reel",
        items: [{ url: args.video_url, type: "video" }],
        publish_at: args.publish_at,
        options: {
          caption: args.caption,
          cover_url: args.cover_url,
          thumb_offset: args.thumb_offset,
          share_to_feed: args.share_to_feed,
          audio_name: args.audio_name,
          trial_graduation: args.trial_graduation,
          user_tags: args.user_tags,
          location_id: args.location_id,
          is_ai_generated: args.is_ai_generated,
        },
      });
    }
    case "ig_post_story": {
      checkUrl(args.media_url, "media_url");
      const type = args.media_type || mediaTypeOfUrl(args.media_url);
      if (!type) throw new ToolError("The URL has no file extension, so set media_type to image or video.");
      return submitPost(env, {
        account: args.account,
        kind: "story",
        items: [{ url: args.media_url, type }],
        publish_at: args.publish_at,
        options: { user_tags: args.user_tags },
      });
    }
    case "ig_get_post": {
      const post = await getPost(env, args.id);
      if (!post) throw new ToolError("No post with that id.");
      const acct = await env.DB.prepare("SELECT username FROM accounts WHERE ig_user_id = ?").bind(post.ig_user_id).first();
      return textResult(describe(post, acct));
    }
    case "ig_list_posts": {
      const where = [];
      const binds = [];
      if (args.account) {
        where.push("ig_user_id = ?");
        binds.push((await resolveAccount(env, args.account)).ig_user_id);
      }
      if (args.status === "open") where.push("status IN ('queued', 'preparing', 'processing', 'publishing')");
      else if (args.status) {
        where.push("status = ?");
        binds.push(args.status);
      }
      const sql = `SELECT id FROM posts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY publish_at DESC LIMIT ?`;
      const { results } = await env.DB.prepare(sql)
        .bind(...binds, Math.min(args.limit || 25, 100))
        .all();
      const posts = await Promise.all(results.map((r) => getPost(env, r.id)));
      const { results: accounts } = await env.DB.prepare("SELECT ig_user_id, username FROM accounts").all();
      return textResult(posts.map((p) => describe(p, accounts.find((a) => a.ig_user_id === p.ig_user_id))));
    }
    case "ig_cancel_post": {
      const result = await cancelPost(env, args.id);
      if (!result.ok) throw new ToolError(result.reason);
      return textResult("Canceled.");
    }
    case "ig_reschedule_post": {
      const { publishAt } = parsePublishAt(args.publish_at);
      if (!(await reschedulePost(env, args.id, publishAt))) {
        throw new ToolError("That post can't be moved. It may already be publishing or finished.");
      }
      return textResult(describe(await getPost(env, args.id)));
    }
    case "ig_publishing_limit": {
      const acct = await resolveAccount(env, args.account);
      const token = await accountToken(env, acct.ig_user_id);
      return textResult(
        await igGet(env, token, `${acct.ig_user_id}/content_publishing_limit`, { fields: "config,quota_usage" }),
      );
    }
    case "ig_recent_media": {
      const acct = await resolveAccount(env, args.account);
      const token = await accountToken(env, acct.ig_user_id);
      return textResult(
        await igGet(env, token, `${acct.ig_user_id}/media`, {
          fields: "id,caption,media_type,media_product_type,permalink,timestamp",
          limit: Math.min(args.limit || 10, 50),
        }),
      );
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

async function handleRpc(msg, env, request) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return fail(-32600, "Invalid Request");
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        return reply(await runTool(name, params?.arguments || {}, env, request, baseUrl(request)));
      } catch (err) {
        return reply(textResult(err?.message || String(err), true));
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request, env, cors) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(payload)) {
    const results = (await Promise.all(payload.map((m) => handleRpc(m, env, request)))).filter(Boolean);
    return results.length ? json(results) : new Response(null, { status: 202, headers: cors });
  }
  const result = await handleRpc(payload, env, request);
  return result ? json(result) : new Response(null, { status: 202, headers: cors });
}

