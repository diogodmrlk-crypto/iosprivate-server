const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function openDatabase(filename = process.env.SQLITE_PATH || (process.env.NODE_ENV === 'production' ? '/var/data/iosprivate.sqlite' : path.join(process.cwd(), 'data', 'iosprivate.sqlite'))) {
  if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_PERSISTENT_DISK !== 'false') {
    if (!filename.startsWith('/var/data/')) throw new Error('Produção exige SQLITE_PATH em /var/data.');
    const mounted = fs.existsSync('/proc/self/mountinfo') && fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => line.split(' ')[4] === '/var/data');
    if (!mounted) throw new Error('Persistent Disk/volume não está montado em /var/data; aplicação interrompida para proteger as keys.');
  }
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const migrations = [{ version: 1, sql: `
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('hourly','daily','weekly','monthly','perm')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','revoked')),
      used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
      device TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      expires_at TEXT,
      last_online_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);
    CREATE INDEX IF NOT EXISTS idx_licenses_username ON licenses(username);
    CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
    CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON licenses(expires_at);
  `}];
  const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x => x.version);
  for (const migration of migrations) if (!applied.includes(migration.version)) {
    const tx = db.transaction(() => { db.exec(migration.sql); db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(migration.version); });
    tx();
  }
  return db;
}
module.exports = { openDatabase };
