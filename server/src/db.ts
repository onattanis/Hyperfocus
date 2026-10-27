import type { Client, InValue } from '@libsql/client';

/**
 * Schema. Safe to run on every start (IF NOT EXISTS), on Node and on Cloudflare D1 alike:
 * a fresh database sets itself up the first time the app runs.
 */
export const MIGRATIONS: string[] = [
  // The one person who writes in this installation. A single row (id = 1).
  `CREATE TABLE IF NOT EXISTS owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT 'Untitled',
    author TEXT NOT NULL DEFAULT '',
    synopsis TEXT NOT NULL DEFAULT '',
    cover_url TEXT,
    map_url TEXT,
    page_capacity INTEGER NOT NULL DEFAULT 500,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS books_position ON books(position)`,
  `CREATE TABLE IF NOT EXISTS book_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    music_url TEXT,
    music_from INTEGER,
    music_to INTEGER,
    epigraph TEXT,
    epigraph_by TEXT,
    epigraph_quotes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS book_chapters_book ON book_chapters(book_id, ord)`,
  // The notebook on the shelf (one row): notes, note tabs and the personal spelling dictionary.
  `CREATE TABLE IF NOT EXISTS notebook (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    notes TEXT NOT NULL DEFAULT '[]',
    tabs TEXT NOT NULL DEFAULT '[]',
    dictionary TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT
  )`,
];

/**
 * Columns added after the first release. Missing ones are added on start (ALTER TABLE cannot be repeated,
 * so each column is checked first).
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; sql: string }[] = [
  { table: 'books', column: 'back_cover_url', sql: 'ALTER TABLE books ADD COLUMN back_cover_url TEXT' },
  { table: 'books', column: 'spine_url', sql: 'ALTER TABLE books ADD COLUMN spine_url TEXT' },
];

export async function migrate(db: Client, opts: { pragma?: boolean } = {}) {
  // SQLite needs foreign keys switched on per connection; D1 has them on already.
  if (opts.pragma !== false) await db.execute('PRAGMA foreign_keys = ON');
  await db.batch(MIGRATIONS, 'write');
  for (const m of COLUMN_MIGRATIONS) {
    const cols = await db.execute(`PRAGMA table_info(${m.table})`);
    if (!cols.rows.some((r) => r.name === m.column)) await db.execute(m.sql);
  }
}

export type Row = Record<string, unknown>;

export async function all<T = Row>(db: Client, sql: string, args: InValue[] = []): Promise<T[]> {
  const r = await db.execute({ sql, args });
  return r.rows as unknown as T[];
}

export async function one<T = Row>(db: Client, sql: string, args: InValue[] = []): Promise<T | undefined> {
  const r = await db.execute({ sql, args });
  return r.rows[0] as unknown as T | undefined;
}

export async function run(db: Client, sql: string, args: InValue[] = []) {
  return db.execute({ sql, args });
}

export const nowIso = () => new Date().toISOString();
