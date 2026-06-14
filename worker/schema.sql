CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  industry_scope TEXT NOT NULL,
  situation TEXT,
  unexpected_value TEXT,
  created_at TEXT NOT NULL,
  ua TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_applications_created ON applications(created_at);
