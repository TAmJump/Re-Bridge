CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  region TEXT,
  litigation TEXT,
  litigation_note TEXT,
  debt TEXT,
  trouble TEXT,
  status TEXT NOT NULL DEFAULT '新規',
  admin_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ua TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_created ON applications(created_at);
CREATE INDEX IF NOT EXISTS idx_app_token ON applications(token);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_app ON messages(app_id, created_at);
