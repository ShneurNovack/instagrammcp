# instagrammcp

MCP server for publishing and scheduling to Instagram professional accounts through Meta's official Instagram API with Instagram Login. Runs on Cloudflare Workers with D1 and R2. GitHub pushes to `main` deploy automatically.

## What it does

- Publishes images, carousels (up to 20 slides), reels, and stories, now or at a set time
- Handles multiple accounts, each connected through Instagram's own login
- Hosts media in R2 so Meta can fetch it, with one-time upload links and imports from direct URLs
- Converts PNG and WebP to JPEG, since Instagram only takes JPEG
- Refreshes login tokens before their 60 days run out
- Reads comments and insights on posts and the account
- Runs a cron every minute, so scheduled posts and slow video processing finish on their own

## Setup

1. Use a Meta app that has API setup with Instagram login. New apps don't offer it, so this runs on the older Chabad Display app. Meta calls this login legacy, so it could go away.
2. Add `https://instagrammcp.shneur.workers.dev/auth/callback` as the OAuth redirect URI.
3. Add each Instagram account as an Instagram tester, and accept the invite in that account.
4. Open `/setup?key=<MCP_TOKEN>` and save the Instagram App ID and App Secret.
5. Open `/connect?key=<MCP_TOKEN>` and log in, once per account.
6. Add `https://instagrammcp.shneur.workers.dev/?bearer_token=<MCP_TOKEN>` as a custom connector.

## Secrets

Set on the Worker, never in this repo:

- `MCP_TOKEN`: guards the MCP endpoint and the setup pages
- `ENCRYPTION_KEY`: encrypts Instagram tokens and the app secret in D1

## Limits

From Meta's API, not this server: no story stickers, no licensed music, and no collaborators with Instagram Login. Collab invites would need Facebook Login, which needs a linked Page (see commit cbbb70a for that version). Image posts must be 4:5 to 1.91:1.

## Development

`npm test` runs the full flow locally against a fake Meta, covering login, uploads, every post type, scheduling, failures, and racing crons. Schema lives in `migrations/`.
