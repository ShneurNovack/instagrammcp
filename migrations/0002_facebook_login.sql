ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'instagram';
ALTER TABLE accounts ADD COLUMN page_id TEXT;
ALTER TABLE accounts ADD COLUMN page_name TEXT;
