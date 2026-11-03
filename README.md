# instagrammcp

MCP server for publishing and scheduling to Instagram professional accounts through Meta's official Instagram API with Facebook Login. Runs on Cloudflare Workers with D1 and R2. GitHub pushes to `main` deploy automatically.

## What it does

- Publishes images, carousels (up to 20 slides), reels, and stories, now or at a set time
- Handles multiple accounts, each connected through the Facebook Page it's linked to
- Supports collab invites on feed posts, carousels, and reels
- Hosts media in R2 so Meta can fetch it, with one-time upload links and imports from direct URLs
- Converts PNG and WebP to JPEG, since Instagram only takes JPEG
- Runs a cron every minute, so scheduled posts and slow video processing finish on their own

## Setup

1. Create a Meta app with the Instagram use case and API setup with Facebook login.
2. Add `https://instagrammcp.shneur.workers.dev/auth/callback` as a valid OAuth redirect URI.
3. Link each Instagram professional account to a Facebook Page your Facebook account can manage.
4. Open `/setup?key=<MCP_TOKEN>` and save the App ID and App Secret.
5. Open `/connect?key=<MCP_TOKEN>`, log in with Facebook, and pick those Pages.
6. Add `https://instagrammcp.shneur.workers.dev/?bearer_token=<MCP_TOKEN>` as a custom connector.

New Meta apps no longer offer Instagram Login, which is why this goes through Facebook. Page tokens don't expire on a timer, but changing the Facebook password or removing the app ends them, and reconnecting fixes that.

## Secrets

Set on the Worker, never in this repo:

- `MCP_TOKEN`: guards the MCP endpoint and the setup pages
- `ENCRYPTION_KEY`: encrypts Page tokens and the app secret in D1

## Limits

From Meta's API, not this server: no story stickers and no licensed music. Image posts must be 4:5 to 1.91:1.

## Development

`npm test` runs the full flow locally against a fake Meta, covering login, uploads, every post type, scheduling, failures, and racing crons. Schema lives in `migrations/`.
