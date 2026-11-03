CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  ig_user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT,
  account_type TEXT,
  token_enc TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  token_refreshed_at INTEGER NOT NULL,
  permissions TEXT,
  last_error TEXT,
  connected_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  ig_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  items TEXT NOT NULL,
  options TEXT NOT NULL,
  publish_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  children TEXT,
  container_id TEXT,
  media_id TEXT,
  permalink TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS posts_status_time ON posts (status, publish_at);
CREATE TABLE IF NOT EXISTS media (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  token TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
