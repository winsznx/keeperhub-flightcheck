-- Faucet state.
--
-- Two tables carry the atomicity, and both do it with a primary-key insert rather than a
-- read-then-write. A read-then-write under concurrency is exactly how a faucet double-sends.
--
--   claims.request_id        makes a replay of the same requestId return the original result
--   recipient_window PK      makes the per-recipient cooldown a race the database resolves
--
-- The reservation is taken BEFORE anything is signed. If signing or sending then fails, the row
-- is moved to a terminal failure state rather than deleted, so a failed attempt cannot be
-- retried into a second transaction under the same request id.

CREATE TABLE IF NOT EXISTS claims (
  request_id   TEXT PRIMARY KEY,
  recipient    TEXT NOT NULL,
  amount_wei   TEXT NOT NULL,
  status       TEXT NOT NULL,          -- reserved | funded | failed
  tx_hash      TEXT,
  error_code   TEXT,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_claims_recipient_time ON claims (recipient, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims (created_at);

-- One row per (recipient, cooldown window). The primary key is the lock.
CREATE TABLE IF NOT EXISTS recipient_window (
  recipient     TEXT NOT NULL,
  window_bucket INTEGER NOT NULL,
  request_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (recipient, window_bucket)
);

-- Rate buckets. `bucket` is an HMAC of the client IP plus a window, or a global window key.
-- Raw IP addresses are never stored.
CREATE TABLE IF NOT EXISTS rate_buckets (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  wei_total    TEXT NOT NULL DEFAULT '0',
  window_start INTEGER NOT NULL
);
