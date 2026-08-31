'use strict';

const session = require('express-session');
const db = require('../db');

/** Minimal durable express-session store for the single-node SQLite deployment. */
class SqliteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT session_json, expires_at FROM http_sessions WHERE sid = ?').get(sid);
      if (!row || row.expires_at <= Date.now()) {
        if (row) db.prepare('DELETE FROM http_sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.session_json));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value && value.cookie && value.cookie.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      db.prepare(
        `INSERT INTO http_sessions (sid, session_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET session_json = excluded.session_json,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`
      ).run(sid, JSON.stringify(value), expiresAt, new Date().toISOString());
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare('DELETE FROM http_sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    this.set(sid, value, callback);
  }
}

module.exports = { SqliteSessionStore };
