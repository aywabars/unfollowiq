const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const db = new Database(path.join(__dirname, '..', 'data.db'));
db.pragma('journal_mode = WAL');

// ===== INIT TABLES =====
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS instagram_sessions (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    session_id TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    ig_user_id TEXT,
    username TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS followers_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    ig_username TEXT NOT NULL,
    ig_pk TEXT NOT NULL,
    full_name TEXT DEFAULT '',
    list_type TEXT NOT NULL,
    scanned_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS non_followers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    ig_username TEXT NOT NULL,
    ig_pk TEXT NOT NULL,
    full_name TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    processed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    status TEXT DEFAULT 'running',
    total_count INTEGER DEFAULT 0,
    processed_count INTEGER DEFAULT 0,
    unfollowed_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    last_activity TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS job_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    job_id TEXT REFERENCES jobs(id),
    message TEXT NOT NULL,
    level TEXT DEFAULT 'info',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_non_followers_user ON non_followers(user_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
  CREATE INDEX IF NOT EXISTS idx_followers_data_user ON followers_data(user_id, list_type);
`);

module.exports = {
  // Users
  createUser(id, email, passwordHash) {
    db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, email, passwordHash);
    return { id, email };
  },

  getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  getUserById(id) {
    return db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(id);
  },

  // Instagram Sessions
  saveInstagramSession(userId, { sessionId, csrfToken, igUserId, username }) {
    db.prepare(`INSERT OR REPLACE INTO instagram_sessions (user_id, session_id, csrf_token, ig_user_id, username, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(userId, sessionId, csrfToken, igUserId || null, username || null);
  },

  getInstagramSession(userId) {
    return db.prepare('SELECT * FROM instagram_sessions WHERE user_id = ?').get(userId);
  },

  // Followers Data
  saveFollowersData(userId, users, listType) {
    const del = db.prepare('DELETE FROM followers_data WHERE user_id = ? AND list_type = ?');
    const ins = db.prepare('INSERT INTO followers_data (user_id, ig_username, ig_pk, full_name, list_type) VALUES (?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      del.run(userId, listType);
      for (const u of users) {
        ins.run(userId, u.username, u.pk, u.full_name || '', listType);
      }
    });
    tx();
  },

  getFollowersData(userId, listType) {
    return db.prepare('SELECT ig_username as username, ig_pk as pk, full_name FROM followers_data WHERE user_id = ? AND list_type = ?').all(userId, listType);
  },

  // Non-Followers
  saveNonFollowers(userId, users) {
    const del = db.prepare('DELETE FROM non_followers WHERE user_id = ? AND status = ?');
    const ins = db.prepare('INSERT INTO non_followers (user_id, ig_username, ig_pk, full_name, status) VALUES (?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      del.run(userId, 'pending');
      for (const u of users) {
        ins.run(userId, u.username, u.pk, u.full_name || '', 'pending');
      }
    });
    tx();
  },

  getNonFollowers(userId) {
    return db.prepare('SELECT * FROM non_followers WHERE user_id = ? ORDER BY status ASC, id ASC').all(userId);
  },

  updateNonFollowerStatus(id, status) {
    db.prepare("UPDATE non_followers SET status = ?, processed_at = datetime('now') WHERE id = ?").run(status, id);
  },

  getPendingNonFollowers(userId, limit = 1) {
    return db.prepare('SELECT * FROM non_followers WHERE user_id = ? AND status = ? LIMIT ?').all(userId, 'pending', limit);
  },

  // Jobs
  createJob(userId, type, totalCount) {
    const id = uuidv4();
    db.prepare('INSERT INTO jobs (id, user_id, type, total_count) VALUES (?, ?, ?, ?)').run(id, userId, type, totalCount);
    return id;
  },

  getActiveJob(userId) {
    return db.prepare("SELECT * FROM jobs WHERE user_id = ? AND status IN ('running', 'paused') ORDER BY started_at DESC LIMIT 1").get(userId);
  },

  updateJob(jobId, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    db.prepare(`UPDATE jobs SET ${fields}, last_activity = datetime('now') WHERE id = ?`).run(...values, jobId);
  },

  getJobStats(userId) {
    const total = db.prepare('SELECT COUNT(*) as count FROM non_followers WHERE user_id = ?').get(userId);
    const unfollowed = db.prepare("SELECT COUNT(*) as count FROM non_followers WHERE user_id = ? AND status = 'unfollowed'").get(userId);
    const pending = db.prepare("SELECT COUNT(*) as count FROM non_followers WHERE user_id = ? AND status = 'pending'").get(userId);
    const errors = db.prepare("SELECT COUNT(*) as count FROM non_followers WHERE user_id = ? AND status = 'error'").get(userId);
    return { total: total.count, unfollowed: unfollowed.count, pending: pending.count, errors: errors.count };
  },

  // Logs
  addLog(userId, jobId, message, level = 'info') {
    db.prepare('INSERT INTO job_logs (user_id, job_id, message, level) VALUES (?, ?, ?, ?)').run(userId, jobId, message, level);
  },

  getJobLogs(userId, limit = 50) {
    return db.prepare('SELECT * FROM job_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  }
};
