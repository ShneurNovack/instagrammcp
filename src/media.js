// Media hosting. Meta pulls every file from a public URL, so uploads land in R2
// and are served from /media/<random key>. Images must be JPEG for Instagram, so
// PNG and WebP are converted on the way in.

import { baseUrl, randomId } from "./util.js";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 95 * 1024 * 1024;
const RETENTION = 14 * DAY;

const TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function extensionOf(name) {
  const clean = String(name || "").split("?")[0].split("#")[0];
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

export function mediaTypeOfUrl(url) {
  const type = TYPES[extensionOf(new URL(url).pathname)];
  if (!type) return null;
  return type.startsWith("video/") ? "video" : "image";
}

function sniffImage(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return null;
}

async function toJpeg(env, buffer) {
  if (!env.IMAGES) throw new Error("Image conversion is not available. Convert the file to JPEG and upload again.");
  const stream = new Blob([buffer]).stream();
  const output = await env.IMAGES.input(stream).output({ format: "image/jpeg", quality: 92 });
  return output.response().arrayBuffer();
}

async function storeImage(env, buffer) {
  const bytes = new Uint8Array(buffer);
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new Error("That file is not a JPEG, PNG, or WebP image.");
  const jpeg = sniffed === "image/jpeg" ? buffer : await toJpeg(env, buffer);
  if (jpeg.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is ${(jpeg.byteLength / 1048576).toFixed(1)} MB and Instagram's limit is 8 MB.`);
  }
  const key = `${randomId(18)}.jpg`;
  await env.MEDIA.put(key, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
  return recordMedia(env, key, "image/jpeg", jpeg.byteLength, sniffed !== "image/jpeg");
}

async function recordMedia(env, key, contentType, size, converted = false) {
  await env.DB.prepare("INSERT INTO media (key, content_type, size, created_at) VALUES (?, ?, ?, ?)")
    .bind(key, contentType, size, Date.now())
    .run();
  return { key, contentType, size, converted };
}

export function publicUrl(origin, key) {
  return `${origin}/media/${key}`;
}

export async function createUpload(env, request, filename) {
  const contentType = TYPES[extensionOf(filename)];
  if (!contentType) throw new Error("Use a .jpg, .png, .webp, .mp4, or .mov filename.");
  const token = randomId(24);
  const key = `${randomId(18)}.${contentType === "video/quicktime" ? "mov" : contentType === "video/mp4" ? "mp4" : "jpg"}`;
  await env.DB.prepare("INSERT INTO uploads (token, filename, key, content_type, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(token, filename, key, contentType, Date.now() + 2 * HOUR)
    .run();
  const origin = baseUrl(request);
  return { uploadUrl: `${origin}/upload/${token}`, contentType, isVideo: contentType.startsWith("video/") };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function finishedUpload(env, request, stored) {
  return jsonResponse({
    media_url: publicUrl(baseUrl(request), stored.key),
    content_type: stored.contentType,
    size: stored.size,
    converted_to_jpeg: stored.converted,
  });
}

// PUT /upload/<token>                        one shot, up to Cloudflare's 100 MB body limit
// POST /upload/<token>?action=start          begin a multipart upload for bigger videos
// PUT /upload/<token>?upload_id=..&part=N    send one part
// POST /upload/<token>?action=complete&upload_id=..  body: {"parts":[{"partNumber":1,"etag":"..."}]}
export async function handleUpload(request, env, token) {
  const row = await env.DB.prepare("SELECT * FROM uploads WHERE token = ? AND expires_at > ?")
    .bind(token, Date.now())
    .first();
  if (!row) return jsonResponse({ error: "This upload link is expired or already used." }, 404);

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const uploadId = url.searchParams.get("upload_id");
  const isVideo = row.content_type.startsWith("video/");
  const consume = () => env.DB.prepare("DELETE FROM uploads WHERE token = ?").bind(token).run();

  try {
    if (request.method === "POST" && action === "start") {
      if (!isVideo) return jsonResponse({ error: "Multipart upload is only for video." }, 400);
      const upload = await env.MEDIA.createMultipartUpload(row.key, { httpMetadata: { contentType: row.content_type } });
      return jsonResponse({ upload_id: upload.uploadId });
    }
    if (request.method === "PUT" && uploadId) {
      const partNumber = Number(url.searchParams.get("part"));
      const upload = env.MEDIA.resumeMultipartUpload(row.key, uploadId);
      const part = await upload.uploadPart(partNumber, request.body);
      return jsonResponse({ partNumber: part.partNumber, etag: part.etag });
    }
    if (request.method === "POST" && action === "complete") {
      const { parts } = await request.json();
      const upload = env.MEDIA.resumeMultipartUpload(row.key, uploadId);
      const object = await upload.complete(parts);
      await consume();
      return finishedUpload(env, request, await recordMedia(env, row.key, row.content_type, object.size));
    }
    if (request.method === "PUT") {
      if (isVideo) {
        const object = await env.MEDIA.put(row.key, request.body, { httpMetadata: { contentType: row.content_type } });
        await consume();
        return finishedUpload(env, request, await recordMedia(env, row.key, row.content_type, object.size));
      }
      const stored = await storeImage(env, await request.arrayBuffer());
      await consume();
      return finishedUpload(env, request, stored);
    }
    return jsonResponse({ error: "Unsupported upload request." }, 405);
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }
}

export async function importFromUrl(env, request, sourceUrl) {
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:") throw new Error("The source URL must be https.");
  if (url.hostname.endsWith("dropbox.com")) url.searchParams.set("dl", "1");

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download that file (HTTP ${response.status}).`);
  const headerType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (headerType.startsWith("text/")) {
    throw new Error("That link returned a web page, not a file. Use a direct download link.");
  }

  const fromPath = TYPES[extensionOf(url.pathname)];
  const contentType = headerType.startsWith("video/") || headerType.startsWith("image/") ? headerType : fromPath;
  if (!contentType) throw new Error(`Unsupported file type: ${headerType || "unknown"}.`);

  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_BUFFERED_BYTES) {
    throw new Error("That file is over 95 MB. Use ig_create_upload_url and a multipart upload instead.");
  }
  const buffer = await response.arrayBuffer();
  const stored = contentType.startsWith("image/")
    ? await storeImage(env, buffer)
    : await storeVideo(env, buffer, contentType);
  return { media_url: publicUrl(baseUrl(request), stored.key), content_type: stored.contentType, size: stored.size, converted_to_jpeg: stored.converted };
}

async function storeVideo(env, buffer, contentType) {
  const key = `${randomId(18)}.${contentType === "video/quicktime" ? "mov" : "mp4"}`;
  await env.MEDIA.put(key, buffer, { httpMetadata: { contentType } });
  return recordMedia(env, key, contentType, buffer.byteLength);
}

// Meta's fetcher uses range requests for video, so this has to answer them properly.
export async function handleMedia(request, env, key) {
  if (!/^[A-Za-z0-9_-]+\.(jpg|mp4|mov)$/.test(key)) return new Response("Not found", { status: 404 });

  const rangeHeader = request.headers.get("range");
  const object =
    request.method === "HEAD"
      ? await env.MEDIA.head(key)
      : await env.MEDIA.get(key, rangeHeader ? { range: request.headers } : {});
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=3600");

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(object.size));
    return new Response(null, { status: 200, headers });
  }
  if (rangeHeader && object.range) {
    const start = object.range.offset ?? object.size - object.range.suffix;
    const length = object.range.length ?? object.size - start;
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

// Files stay around long enough to reuse, and always as long as an open post needs them.
export async function cleanup(env) {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM uploads WHERE expires_at < ?").bind(now).run();

  const { results } = await env.DB.prepare("SELECT key FROM media WHERE created_at < ? LIMIT 100")
    .bind(now - RETENTION)
    .all();
  for (const { key } of results) {
    const inUse = await env.DB.prepare(
      `SELECT 1 FROM posts WHERE status IN ('queued', 'preparing', 'processing', 'publishing')
       AND (items LIKE ? OR options LIKE ?) LIMIT 1`,
    )
      .bind(`%${key}%`, `%${key}%`)
      .first();
    if (inUse) continue;
    await env.MEDIA.delete(key);
    await env.DB.prepare("DELETE FROM media WHERE key = ?").bind(key).run();
  }
}
