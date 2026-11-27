const mysql = require('mysql2/promise');
const { logSafe } = require('./security');

let pool = null;
let saveChain = Promise.resolve();

function enabled() {
  return Boolean((process.env.DATABASE_URL || '').trim());
}

function connectionOptions(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('DATABASE_URL is not a valid mysql:// address. On Aiven, use the copy button next to Service URI.');
  }
  if (url.protocol !== 'mysql:') {
    throw new Error('DATABASE_URL must start with mysql://');
  }
  if (!url.hostname || !url.username || !url.password) {
    throw new Error('DATABASE_URL is missing the user, the password, or the @ before the host. Copy the Service URI from Aiven.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'defaultdb';
  const sslMode = (url.searchParams.get('ssl-mode') || url.searchParams.get('sslmode') || '').toUpperCase();
  const options = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    waitForConnections: true,
    connectionLimit: 4,
    connectTimeout: 20000,
    enableKeepAlive: true
  };
  if (sslMode === 'REQUIRED' || url.hostname.endsWith('.aivencloud.com')) {
    options.ssl = { rejectUnauthorized: false };
  }
  return options;
}

async function writePayload(payload) {
  await pool.query(
    `INSERT INTO relay_store (id, payload) VALUES ('main', ?)
     ON DUPLICATE KEY UPDATE payload = ?`,
    [payload, payload]
  );
}

async function init() {
  const options = connectionOptions(process.env.DATABASE_URL || '');
  pool = mysql.createPool(options);
  await pool.query('SELECT 1');
  await pool.query(
    `CREATE TABLE IF NOT EXISTS relay_store (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`
  );
  await ensureGoogleTables();
  console.log(`Account storage: MySQL (${options.host})`);
  return options.host;
}

async function ensureGoogleTables() {
  if (!pool) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS rp_users (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      google_sub VARCHAR(64) NOT NULL,
      email VARCHAR(190) NOT NULL,
      name VARCHAR(80) NULL,
      picture VARCHAR(500) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL,
      UNIQUE KEY rp_users_google_sub (google_sub),
      UNIQUE KEY rp_users_email (email)
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS rp_sessions (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      csrf_token VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY rp_sessions_token_hash (token_hash),
      KEY rp_sessions_user_id_idx (user_id),
      KEY rp_sessions_expires_at_idx (expires_at),
      CONSTRAINT rp_sessions_user_fk FOREIGN KEY (user_id) REFERENCES rp_users (id) ON DELETE CASCADE
    )`
  );
}

async function upsertGoogleIdentity({ googleSub, email, name, picture }) {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO rp_users (google_sub, email, name, picture, last_login_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       email = VALUES(email),
       name = VALUES(name),
       picture = VALUES(picture),
       last_login_at = NOW()`,
    [googleSub, email, name, picture]
  );
  const [rows] = await pool.query(
    'SELECT id, email, name, picture FROM rp_users WHERE google_sub = ? LIMIT 1',
    [googleSub]
  );
  return rows[0] || null;
}

async function read() {
  const [rows] = await pool.query('SELECT payload FROM relay_store WHERE id = ?', ['main']);
  if (!rows.length || rows[0].payload == null || rows[0].payload === '') return null;
  const payload = Buffer.isBuffer(rows[0].payload) ? rows[0].payload.toString('utf8') : rows[0].payload;
  return JSON.parse(payload);
}

async function writeNow(data) {
  await writePayload(JSON.stringify(data));
  saveChain = Promise.resolve();
}

function queueSave(data) {
  const payload = JSON.stringify(data);
  saveChain = saveChain
    .then(() => writePayload(payload))
    .catch((err) => {
      logSafe(`MySQL save failed: ${err && err.message ? err.message : 'unknown error'}`);
    });
}

module.exports = {
  enabled,
  connectionOptions,
  init,
  read,
  writeNow,
  queueSave,
  ensureGoogleTables,
  upsertGoogleIdentity
};