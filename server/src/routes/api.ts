import { Hono, type Context } from 'hono';
import {
  DEFAULT_PAGE_CAPACITY,
  accountUpdateSchema,
  bookImageSchema,
  bookNoteSchema,
  bookUpdateSchema,
  chapterUpdateSchema,
  countInDoc,
  dictionaryUpdateSchema,
  loginSchema,
  notebookUpdateSchema,
  noteTabSchema,
  passwordChangeSchema,
  replaceInDoc,
  setupSchema,
  type BookChapter,
  type BookFull,
  type BookImage,
  type BookNote,
  type BookSummary,
  type FindOptions,
  type NotebookSummary,
  type NoteTab,
  type SetupStatus,
  type ShelfResponse,
  type StorageUsage,
} from '@hyperfocus/shared';
import { z } from 'zod';
import { all, nowIso, one, run } from '../db';
import { endSession, hashPassword, rateLimiter, requireOwner, sameText, startSession, verifyPassword } from '../auth';
import { saveAudioUpload, saveImageUpload } from '../uploads';
import type { AppEnv } from '../types';

const loginLimit = rateLimiter(8, 15 * 60_000);
let dummyHash: Promise<string> | null = null;

interface BookRow {
  id: number;
  position: number;
  title: string;
  author: string;
  synopsis: string;
  cover_url: string | null;
  back_cover_url: string | null;
  spine_url: string | null;
  map_url: string | null;
  page_capacity: number;
  updated_at: string;
  chapter_count?: number;
}

interface ChapterRow {
  id: number;
  ord: number;
  title: string;
  content: string;
  music_url: string | null;
  music_from: number | null;
  music_to: number | null;
  epigraph: string | null;
  epigraph_by: string | null;
  epigraph_quotes: number | null;
  images: string | null;
  updated_at: string;
}

const toBook = (r: BookRow): BookSummary => ({
  id: Number(r.id),
  position: Number(r.position),
  title: r.title,
  author: r.author,
  synopsis: r.synopsis,
  coverUrl: r.cover_url,
  backCoverUrl: r.back_cover_url ?? null,
  spineUrl: r.spine_url ?? null,
  mapUrl: r.map_url,
  pageCapacity: Number(r.page_capacity),
  chapterCount: Number(r.chapter_count ?? 0),
  updatedAt: r.updated_at,
});

const emptyContent = () => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });

const parseJson = <T>(json: string | null | undefined, schema: z.ZodType<T>, fallback: T): T => {
  try {
    const parsed = schema.safeParse(JSON.parse(json || 'null'));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback; // damaged record: show it empty rather than fail
  }
};

const toChapter = (r: ChapterRow): BookChapter => {
  let content: unknown;
  try {
    content = JSON.parse(r.content || emptyContent());
  } catch {
    content = JSON.parse(emptyContent());
  }
  const images: BookImage[] = parseJson(r.images, bookImageSchema.array(), []);
  return {
    id: Number(r.id),
    ord: Number(r.ord),
    title: r.title,
    content,
    musicUrl: r.music_url,
    musicFrom: r.music_from ?? null,
    musicTo: r.music_to ?? null,
    epigraph: r.epigraph ?? null,
    epigraphBy: r.epigraph_by ?? null,
    epigraphQuotes: !!r.epigraph_quotes,
    images,
    updatedAt: r.updated_at,
  };
};

const parseNotes = (json: string | null | undefined): BookNote[] => parseJson(json, bookNoteSchema.array(), []);
const parseTabs = (json: string | null | undefined): NoteTab[] => parseJson(json, noteTabSchema.array(), []);
const parseDoc = (json: string) => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

const bookExists = async (c: Context<AppEnv>, id: number) => !!(await one(c.var.db, 'SELECT 1 FROM books WHERE id = ?', [id]));
const chapterBook = (c: Context<AppEnv>, id: number) => one<{ book_id: number }>(c.var.db, 'SELECT book_id FROM book_chapters WHERE id = ?', [id]);
const touchBook = (c: Context<AppEnv>, bookId: number) => run(c.var.db, 'UPDATE books SET updated_at = ? WHERE id = ?', [nowIso(), bookId]);

/** Search / replace request: the word and its options. */
const findQuerySchema = z.object({
  q: z.string().min(1).max(200),
  whole: z.boolean().default(true),
  matchCase: z.boolean().default(false),
});
const replaceSchema = findQuerySchema.extend({
  with: z.string().max(200),
  /** This book is skipped (the open book is changed in the editor, not on the server). */
  exclude: z.number().int().optional(),
});

/** Every chapter of every book, in shelf order. */
const allChapters = (c: Context<AppEnv>) =>
  all<{ id: number; book_id: number; title: string; content: string; position: number; book_title: string }>(
    c.var.db,
    `SELECT ch.id, ch.book_id, ch.title, ch.content, b.position, b.title AS book_title
       FROM book_chapters ch JOIN books b ON b.id = ch.book_id
      ORDER BY b.position, b.id, ch.ord, ch.id`,
  );

export const apiRoutes = new Hono<AppEnv>()
  // ---- Account (before sign-in) ----
  .get('/status', async (c) => {
    c.header('Cache-Control', 'no-store');
    const owner = await one(c.var.db, 'SELECT 1 FROM owner WHERE id = 1');
    const status: SetupStatus = { needsSetup: !owner, tokenRequired: !!c.var.config.setupToken || !!c.var.config.setupTokenRequired };
    return c.json(status);
  })
  // First start: create the owner account (only while there is none).
  .post('/setup', async (c) => {
    if (!loginLimit(c.var.clientIp)) return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    const body = setupSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400);
    const token = c.var.config.setupToken;
    if (c.var.config.setupTokenRequired && !token)
      return c.json({ error: 'Set the SETUP_TOKEN secret first, then create your account with it.' }, 503);
    if (token && !sameText(body.data.token ?? '', token)) return c.json({ error: 'Wrong setup code' }, 403);
    const hash = await hashPassword(body.data.password);
    // INSERT OR IGNORE + id = 1: if two requests race, only the first one creates the account.
    const r = await run(c.var.db, 'INSERT OR IGNORE INTO owner (id, username, password_hash, display_name) VALUES (1, ?, ?, ?)', [
      body.data.username.toLowerCase(),
      hash,
      body.data.displayName || body.data.username,
    ]);
    if (!r.rowsAffected) return c.json({ error: 'The account already exists. Please sign in.' }, 409);
    await startSession(c, 1);
    return c.json({ ok: true }, 201);
  })
  .post('/login', async (c) => {
    if (!loginLimit(c.var.clientIp)) return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    const body = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Username and password are required' }, 400);
    const o = await one<{ username: string; password_hash: string; session_version: number }>(
      c.var.db,
      'SELECT username, password_hash, session_version FROM owner WHERE id = 1',
    );
    // Same work and same answer whether or not the username exists (nothing leaks).
    dummyHash ??= hashPassword('not-a-real-password');
    const ok = await verifyPassword(body.data.password, o?.password_hash ?? (await dummyHash));
    if (!o || !ok || body.data.username.toLowerCase() !== o.username) return c.json({ error: 'Wrong username or password' }, 401);
    await startSession(c, Number(o.session_version));
    return c.json({ ok: true });
  })
  .post('/logout', (c) => {
    endSession(c);
    return c.json({ ok: true });
  })

  // ---- Everything below needs the owner to be signed in ----
  .use('*', requireOwner)
  .get('/me', async (c) => {
    c.header('Cache-Control', 'no-store');
    const o = await one<{ username: string; display_name: string }>(c.var.db, 'SELECT username, display_name FROM owner WHERE id = 1');
    return c.json({ username: o?.username ?? '', displayName: o?.display_name ?? '' });
  })
  .patch('/account', async (c) => {
    const body = accountUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400);
    await run(c.var.db, 'UPDATE owner SET display_name = ? WHERE id = 1', [body.data.displayName]);
    return c.json({ ok: true });
  })
  // Changing the password signs out every other device (new session version); this one stays signed in.
  .post('/account/password', async (c) => {
    const body = passwordChangeSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400);
    const o = await one<{ password_hash: string; session_version: number }>(c.var.db, 'SELECT password_hash, session_version FROM owner WHERE id = 1');
    if (!o || !(await verifyPassword(body.data.current, o.password_hash))) return c.json({ error: 'The current password is wrong' }, 400);
    const sv = Number(o.session_version) + 1;
    await run(c.var.db, 'UPDATE owner SET password_hash = ?, session_version = ? WHERE id = 1', [await hashPassword(body.data.next), sv]);
    await startSession(c, sv);
    return c.json({ ok: true });
  })
  .get('/storage', async (c) => {
    c.header('Cache-Control', 'no-store');
    const media = await one<{ total: number | null }>(c.var.db, 'SELECT SUM(size) AS total FROM uploads');
    // D1 reports the database size after each query; locally (SQLite) it comes from the page count.
    const probe = (await c.var.db.execute('SELECT 1')) as unknown as { dbSize?: number };
    let dbUsed = Number(probe.dbSize ?? 0);
    if (!dbUsed) {
      try {
        const pc = await one<{ page_count: number }>(c.var.db, 'PRAGMA page_count');
        const ps = await one<{ page_size: number }>(c.var.db, 'PRAGMA page_size');
        dbUsed = Number(pc?.page_count ?? 0) * Number(ps?.page_size ?? 0);
      } catch {
        dbUsed = 0;
      }
    }
    const limits = c.var.config.storageLimits;
    const usage: StorageUsage = {
      media: { used: Number(media?.total ?? 0), limit: limits?.media ?? null },
      db: { used: dbUsed, limit: limits?.db ?? null },
    };
    return c.json(usage);
  })
  .post('/uploads', (c) => saveImageUpload(c))
  .post('/audio', (c) => saveAudioUpload(c))

  // ---- Shelf ----
  .get('/books', async (c) => {
    c.header('Cache-Control', 'no-store');
    const db = c.var.db;
    const rows = await all<BookRow & { own_bytes: number }>(
      db,
      `SELECT b.*, (SELECT COUNT(*) FROM book_chapters ch WHERE ch.book_id = b.id) AS chapter_count,
              length(CAST(b.title AS BLOB)) + length(CAST(b.author AS BLOB)) + length(CAST(b.synopsis AS BLOB)) AS own_bytes
       FROM books b ORDER BY b.position, b.id`,
    );
    // Size of a book: its text (bytes) plus the uploaded files it uses (each file counted once).
    const chapters = await all<{ book_id: number; bytes: number; images: string | null; music_url: string | null }>(
      db,
      `SELECT book_id, length(CAST(content AS BLOB)) + length(CAST(COALESCE(images, '') AS BLOB)) + length(CAST(title AS BLOB)) AS bytes,
              images, music_url
       FROM book_chapters`,
    );
    const fileSize = new Map((await all<{ url: string; size: number }>(db, 'SELECT url, size FROM uploads')).map((u) => [u.url, Number(u.size)]));
    const sizes = new Map<number, { text: number; urls: Set<string> }>();
    for (const r of rows) sizes.set(Number(r.id), { text: Number(r.own_bytes ?? 0), urls: new Set([r.cover_url, r.back_cover_url, r.spine_url, r.map_url].filter((u): u is string => !!u)) });
    for (const ch of chapters) {
      const s = sizes.get(Number(ch.book_id));
      if (!s) continue;
      s.text += Number(ch.bytes ?? 0);
      if (ch.music_url) s.urls.add(ch.music_url);
      for (const im of parseJson(ch.images, z.array(z.object({ url: z.string().optional() })), [])) if (im.url) s.urls.add(im.url);
    }
    const sizeOf = (id: number) => {
      const s = sizes.get(id);
      if (!s) return 0;
      let total = s.text;
      for (const u of s.urls) total += fileSize.get(u) ?? 0;
      return total;
    };
    const nb = await one<{ notes: string; updated_at: string | null; bytes: number }>(
      db,
      'SELECT notes, updated_at, length(CAST(notes AS BLOB)) AS bytes FROM notebook WHERE id = 1',
    );
    const notebook: NotebookSummary = { count: parseNotes(nb?.notes).length, updatedAt: nb?.updated_at ?? null, sizeBytes: Number(nb?.bytes ?? 0) };
    const res: ShelfResponse = { books: rows.map((r) => ({ ...toBook(r), sizeBytes: sizeOf(Number(r.id)) })), notebook };
    return c.json(res);
  })
  // A new book goes to the end of the shelf, with one empty chapter.
  .post('/books', async (c) => {
    const body = z.object({ title: z.string().trim().max(200).optional() }).safeParse(await c.req.json().catch(() => ({})));
    const last = await one<{ m: number | null }>(c.var.db, 'SELECT MAX(position) AS m FROM books');
    const owner = await one<{ display_name: string }>(c.var.db, 'SELECT display_name FROM owner WHERE id = 1');
    const r = await run(c.var.db, 'INSERT INTO books (position, title, author, page_capacity) VALUES (?, ?, ?, ?)', [
      Number(last?.m ?? -1) + 1,
      (body.success && body.data.title) || 'Untitled',
      owner?.display_name ?? '',
      DEFAULT_PAGE_CAPACITY,
    ]);
    const id = Number(r.lastInsertRowid);
    await run(c.var.db, 'INSERT INTO book_chapters (book_id, ord, title, content) VALUES (?, 0, ?, ?)', [id, 'Chapter 1', emptyContent()]);
    return c.json({ id }, 201);
  })
  // Shelf order: the ids of every book, first to last.
  .put('/books/order', async (c) => {
    const body = z.object({ ids: z.array(z.number().int()).max(10000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    if (body.data.ids.length)
      await c.var.db.batch(
        body.data.ids.map((id, i) => ({ sql: 'UPDATE books SET position = ? WHERE id = ?', args: [i, id] })),
        'write',
      );
    return c.json({ ok: true });
  })
  .get('/books/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const id = Number(c.req.param('id'));
    const b = await one<BookRow>(c.var.db, 'SELECT * FROM books WHERE id = ?', [id]);
    if (!b) return c.json({ error: 'Book not found' }, 404);
    const chapters = (await all<ChapterRow>(c.var.db, 'SELECT * FROM book_chapters WHERE book_id = ? ORDER BY ord, id', [id])).map(toChapter);
    const book: BookFull = { ...toBook({ ...b, chapter_count: chapters.length }), chapters };
    return c.json({ book });
  })
  .patch('/books/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = bookUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400);
    if (!(await bookExists(c, id))) return c.json({ error: 'Book not found' }, 404);
    const sets: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [nowIso()];
    const map: Record<string, string> = { title: 'title', author: 'author', synopsis: 'synopsis', coverUrl: 'cover_url', backCoverUrl: 'back_cover_url', spineUrl: 'spine_url', mapUrl: 'map_url' };
    for (const [k, col] of Object.entries(map)) {
      const v = body.data[k as keyof typeof body.data];
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        args.push(k === 'title' ? (v as string) || 'Untitled' : (v as string | null));
      }
    }
    args.push(id);
    await run(c.var.db, `UPDATE books SET ${sets.join(', ')} WHERE id = ?`, args);
    return c.json({ ok: true });
  })
  // Deletes the book and its chapters. Uploaded files stay (another book may use the same image).
  .delete('/books/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!(await bookExists(c, id))) return c.json({ error: 'Book not found' }, 404);
    await c.var.db.batch(
      [
        { sql: 'DELETE FROM book_chapters WHERE book_id = ?', args: [id] },
        { sql: 'DELETE FROM books WHERE id = ?', args: [id] },
      ],
      'write',
    );
    return c.json({ ok: true });
  })

  // ---- Notebook (on the shelf) ----
  .get('/notes', async (c) => {
    c.header('Cache-Control', 'no-store');
    const nb = await one<{ notes: string; tabs: string; updated_at: string | null }>(c.var.db, 'SELECT notes, tabs, updated_at FROM notebook WHERE id = 1');
    return c.json({ notes: parseNotes(nb?.notes), tabs: parseTabs(nb?.tabs), updatedAt: nb?.updated_at ?? null });
  })
  .patch('/notes', async (c) => {
    const body = notebookUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400);
    const notes = body.data.notes !== undefined ? JSON.stringify(body.data.notes) : null;
    const tabs = body.data.tabs !== undefined ? JSON.stringify(body.data.tabs) : null;
    if ((notes?.length ?? 0) > 2_000_000) return c.json({ error: 'Notes are too long' }, 400);
    // A field that is not sent stays as it is
    await run(
      c.var.db,
      `INSERT INTO notebook (id, notes, tabs, updated_at) VALUES (1, COALESCE(?, '[]'), COALESCE(?, '[]'), ?)
       ON CONFLICT(id) DO UPDATE SET
         notes = COALESCE(?, notebook.notes),
         tabs = COALESCE(?, notebook.tabs),
         updated_at = excluded.updated_at`,
      [notes, tabs, nowIso(), notes, tabs],
    );
    return c.json({ ok: true });
  })
  // Spell check: the personal dictionary (kept in the notebook row; does not change the notes' date)
  .get('/dictionary', async (c) => {
    c.header('Cache-Control', 'no-store');
    const row = await one<{ dictionary: string | null }>(c.var.db, 'SELECT dictionary FROM notebook WHERE id = 1');
    return c.json({ words: parseJson(row?.dictionary, z.array(z.string()), []) });
  })
  .put('/dictionary', async (c) => {
    const body = dictionaryUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400);
    const words = JSON.stringify([...new Set(body.data.words)].sort());
    await run(
      c.var.db,
      `INSERT INTO notebook (id, notes, tabs, dictionary) VALUES (1, '[]', '[]', ?)
       ON CONFLICT(id) DO UPDATE SET dictionary = excluded.dictionary`,
      [words],
    );
    return c.json({ ok: true });
  })

  // ---- Chapters ----
  .post('/books/:id/chapters', async (c) => {
    const id = Number(c.req.param('id'));
    if (!(await bookExists(c, id))) return c.json({ error: 'Book not found' }, 404);
    const body = z.object({ title: z.string().trim().max(200).optional() }).safeParse(await c.req.json().catch(() => ({})));
    const last = await one<{ m: number | null; n: number }>(c.var.db, 'SELECT MAX(ord) AS m, COUNT(*) AS n FROM book_chapters WHERE book_id = ?', [id]);
    const r = await run(c.var.db, 'INSERT INTO book_chapters (book_id, ord, title, content) VALUES (?, ?, ?, ?)', [
      id,
      Number(last?.m ?? -1) + 1,
      (body.success && body.data.title) || `Chapter ${Number(last?.n ?? 0) + 1}`,
      emptyContent(),
    ]);
    await touchBook(c, id);
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  })
  .put('/books/:id/order', async (c) => {
    const id = Number(c.req.param('id'));
    const body = z.object({ ids: z.array(z.number().int()).max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    if (!(await bookExists(c, id))) return c.json({ error: 'Book not found' }, 404);
    await c.var.db.batch(
      body.data.ids.map((cid, i) => ({ sql: 'UPDATE book_chapters SET ord = ? WHERE id = ? AND book_id = ?', args: [i, cid, id] })),
      'write',
    );
    await touchBook(c, id);
    return c.json({ ok: true });
  })
  .patch('/chapters/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const ch = await chapterBook(c, id);
    if (!ch) return c.json({ error: 'Chapter not found' }, 404);
    const body = chapterUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400);
    const sets: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [nowIso()];
    const d = body.data;
    if (d.title !== undefined) sets.push('title = ?'), args.push(d.title);
    if (d.musicUrl !== undefined) sets.push('music_url = ?'), args.push(d.musicUrl);
    if (d.musicFrom !== undefined) sets.push('music_from = ?'), args.push(d.musicFrom);
    if (d.musicTo !== undefined) sets.push('music_to = ?'), args.push(d.musicTo);
    if (d.epigraph !== undefined) sets.push('epigraph = ?'), args.push(d.epigraph?.trim() || null);
    if (d.epigraphBy !== undefined) sets.push('epigraph_by = ?'), args.push(d.epigraphBy?.trim() || null);
    if (d.epigraphQuotes !== undefined) sets.push('epigraph_quotes = ?'), args.push(d.epigraphQuotes ? 1 : 0);
    if (d.images !== undefined) sets.push('images = ?'), args.push(JSON.stringify(d.images));
    if (d.content !== undefined) {
      const json = JSON.stringify(d.content);
      // A sensible limit for one chapter (~2 MB of text), well under D1's row limit.
      if (json.length > 2_000_000) return c.json({ error: 'This chapter is too long; try splitting it in two' }, 400);
      sets.push('content = ?');
      args.push(json);
    }
    args.push(id);
    await run(c.var.db, `UPDATE book_chapters SET ${sets.join(', ')} WHERE id = ?`, args);
    await touchBook(c, Number(ch.book_id));
    return c.json({ ok: true });
  })
  .delete('/chapters/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const ch = await chapterBook(c, id);
    if (!ch) return c.json({ error: 'Chapter not found' }, 404);
    const n = await one<{ n: number }>(c.var.db, 'SELECT COUNT(*) AS n FROM book_chapters WHERE book_id = ?', [ch.book_id]);
    if (Number(n?.n ?? 0) <= 1) return c.json({ error: 'A book needs at least one chapter' }, 400);
    await run(c.var.db, 'DELETE FROM book_chapters WHERE id = ?', [id]);
    await touchBook(c, Number(ch.book_id));
    return c.json({ ok: true });
  })

  // ---- Find and replace across every book ----
  // Counts per book and chapter (only the ones with matches)
  .post('/search', async (c) => {
    const body = findQuerySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid search' }, 400);
    const o: FindOptions = { wholeWord: body.data.whole, matchCase: body.data.matchCase };
    const books = new Map<number, { id: number; position: number; title: string; total: number; chapters: { id: number; title: string; count: number }[] }>();
    for (const ch of await allChapters(c)) {
      const count = countInDoc(parseDoc(ch.content), body.data.q, o);
      if (!count) continue;
      const bid = Number(ch.book_id);
      let b = books.get(bid);
      if (!b) books.set(bid, (b = { id: bid, position: Number(ch.position), title: ch.book_title, total: 0, chapters: [] }));
      b.total += count;
      b.chapters.push({ id: Number(ch.id), title: ch.title, count });
    }
    return c.json({ books: [...books.values()] });
  })
  .post('/replace', async (c) => {
    const body = replaceSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    const o: FindOptions = { wholeWord: body.data.whole, matchCase: body.data.matchCase };
    let replaced = 0;
    const touched = new Set<number>();
    for (const ch of await allChapters(c)) {
      if (Number(ch.book_id) === body.data.exclude) continue;
      const doc = parseDoc(ch.content);
      if (!doc) continue;
      const r = replaceInDoc(doc, body.data.q, body.data.with, o);
      if (!r.count) continue;
      await run(c.var.db, 'UPDATE book_chapters SET content = ?, updated_at = ? WHERE id = ?', [JSON.stringify(r.doc), nowIso(), ch.id]);
      replaced += r.count;
      touched.add(Number(ch.book_id));
    }
    for (const id of touched) await touchBook(c, id);
    return c.json({ replaced, books: touched.size });
  });
