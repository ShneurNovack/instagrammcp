// Instagram MCP server for Cloudflare Workers.
//
//   POST /?bearer_token=...      MCP endpoint
//   GET  /setup?key=...          save the Meta app
//   GET  /connect?key=...        log in to an Instagram account
//   GET  /auth/callback          Instagram login redirect
//   /upload/<token>              one-time file upload
//   /media/<key>                 public media Meta fetches
//
// The cron runs every minute: it publishes due posts, and tidies up once an hour.

import { handleMcp } from "./mcp.js";
import { cleanup, handleMedia, handleUpload } from "./media.js";
import { authCallback, saveSetup, setupPage, startConnect } from "./pages.js";
import { refreshTokens } from "./instagram.js";
import { runDuePosts } from "./posts.js";
import { safeEqual } from "./util.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

function requestToken(request, url) {
  const header = request.headers.get("authorization") || "";
  return url.searchParams.get("bearer_token") || header.replace(/^Bearer\s+/i, "") || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/media/") && ["GET", "HEAD"].includes(request.method)) {
      return handleMedia(request, env, pathname.slice("/media/".length));
    }
    if (pathname.startsWith("/upload/")) {
      return handleUpload(request, env, pathname.slice("/upload/".length));
    }
    if (pathname === "/auth/callback") return authCallback(request, env);

    if (pathname === "/setup" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!(await safeEqual(key, env.MCP_TOKEN))) return new Response("Not found", { status: 404 });
      return setupPage(request, env, key);
    }
    if (pathname === "/setup" && request.method === "POST") {
      const form = await request.formData();
      if (!(await safeEqual(form.get("key"), env.MCP_TOKEN))) return new Response("Not found", { status: 404 });
      return saveSetup(request, env, form);
    }
    if (pathname === "/connect" && request.method === "GET") {
      if (!(await safeEqual(url.searchParams.get("key"), env.MCP_TOKEN))) return new Response("Not found", { status: 404 });
      return startConnect(request, env);
    }

    if (pathname === "/" || pathname === "/mcp") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, OPTIONS", ...CORS } });
      }
      if (!(await safeEqual(requestToken(request, url), env.MCP_TOKEN))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }
      return handleMcp(request, env, CORS);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await runDuePosts(env);
        if (new Date(event.scheduledTime).getUTCMinutes() === 17) {
          await refreshTokens(env);
          await cleanup(env);
        }
      })(),
    );
  },
};
