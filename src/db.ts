import { Database } from "bun:sqlite";
import { envelopeIndexPath, parseMailboxUrl } from "./paths.ts";
import { listAccounts, type Account } from "./applescript.ts";

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    db = new Database(envelopeIndexPath(), { readonly: true });
    db.exec("PRAGMA query_only = 1; PRAGMA busy_timeout = 5000;");
  }
  return db;
}

export interface Mailbox {
  rowid: number;
  url: string;
  accountId: string;
  account: string;
  path: string;
  total: number;
  unread: number;
}

async function accountsSafe(): Promise<Account[]> {
  try {
    return await listAccounts();
  } catch {
    return [];
  }
}

export async function accountName(id: string): Promise<string> {
  const a = (await accountsSafe()).find((x) => x.id === id);
  return a?.name ?? (id ? id : "local");
}

export async function getMailboxes(): Promise<Mailbox[]> {
  const rows = getDb()
    .query<{ ROWID: number; url: string; total_count: number; unread_count: number }, []>(
      "SELECT ROWID, url, total_count, unread_count FROM mailboxes ORDER BY url",
    )
    .all();
  const accts = await accountsSafe();
  return rows.map((r) => {
    const { accountId, path, local } = parseMailboxUrl(r.url);
    const name = local ? "On My Mac" : (accts.find((a) => a.id === accountId)?.name ?? accountId);
    return { rowid: r.ROWID, url: r.url, accountId, account: name, path, total: r.total_count, unread: r.unread_count };
  });
}

export async function resolveAccount(spec: string): Promise<Account> {
  const accts = await listAccounts();
  const s = spec.toLowerCase();
  const exact = accts.find(
    (a) => a.id.toLowerCase() === s || a.name.toLowerCase() === s || a.emails.some((e) => e.toLowerCase() === s),
  );
  const found =
    exact ??
    accts.find((a) => a.name.toLowerCase().includes(s) || a.emails.some((e) => e.toLowerCase().includes(s)));
  if (!found) throw new Error(`Unknown account "${spec}". Known: ${accts.map((a) => a.name).join(", ")}`);
  return found;
}

const MAILBOX_ALIASES: Record<string, RegExp> = {
  inbox: /^inbox$/i,
  sent: /(^|\/)sent( mail| messages| items)?$/i,
  drafts: /(^|\/)drafts$/i,
  trash: /(^|\/)(trash|deleted messages|deleted items|bin)$/i,
  spam: /(^|\/)(spam|junk)( e-?mail)?$/i,
  junk: /(^|\/)(spam|junk)( e-?mail)?$/i,
  archive: /(^|\/)(archive|all mail)$/i,
  important: /(^|\/)important$/i,
  starred: /(^|\/)starred$/i,
};

export async function resolveMailboxes(spec: string, accountId?: string): Promise<Mailbox[]> {
  const all = (await getMailboxes()).filter((m) => !accountId || m.accountId === accountId);
  const alias = MAILBOX_ALIASES[spec.toLowerCase()];
  let hits = alias ? all.filter((m) => alias.test(m.path)) : [];
  if (!hits.length) hits = all.filter((m) => m.path.toLowerCase() === spec.toLowerCase());
  if (!hits.length) hits = all.filter((m) => m.path.toLowerCase().includes(spec.toLowerCase()));
  if (!hits.length) throw new Error(`No mailbox matching "${spec}"`);
  return hits;
}

/** Accepts ISO dates, "October 1, 2026", or relative forms like 7d / 24h / 2w / today / yesterday. */
export function parseDate(input: string): number {
  const s = input.trim().toLowerCase();
  const now = Date.now();
  const rel = s.match(/^(\d+)\s*(m|h|d|w|mo|y)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3, mo: 30 * 86400e3, y: 365 * 86400e3 }[rel[2]!]!;
    return Math.floor((now - n * unit) / 1000);
  }
  if (s === "today" || s === "yesterday") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (s === "yesterday") d.setDate(d.getDate() - 1);
    return Math.floor(d.getTime() / 1000);
  }
  const t = Date.parse(input);
  if (Number.isNaN(t)) throw new Error(`Unrecognised date "${input}"`);
  return Math.floor(t / 1000);
}

function like(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function tokens(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) out.push((m[1] ?? m[2])!);
  return out;
}

export interface SearchInput {
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  account?: string;
  mailbox?: string;
  since?: string;
  before?: string;
  unread?: boolean;
  flagged?: boolean;
  hasAttachments?: boolean;
  limit?: number;
  offset?: number;
}

export interface MessageRow {
  id: number;
  date: string;
  from: string;
  subject: string;
  account: string;
  mailboxes: string[];
  unread: boolean;
  flagged: boolean;
  attachments: number;
  conversation: number;
  snippet?: string;
}

interface RawRow {
  ROWID: number;
  global_message_id: number;
  conversation_id: number;
  date_received: number;
  read: number;
  flagged: number;
  subject_prefix: string | null;
  subject: string;
  address: string | null;
  comment: string | null;
  summary: string | null;
  mailbox_url: string;
  n_attach: number;
}

const SELECT = `
SELECT m.ROWID, m.global_message_id, m.conversation_id, m.date_received, m.read, m.flagged,
       m.subject_prefix, s.subject, a.address, a.comment, sm.summary, mb.url AS mailbox_url,
       (SELECT count(*) FROM attachments at WHERE at.message = m.ROWID) AS n_attach
FROM messages m
JOIN subjects s ON s.ROWID = m.subject
JOIN mailboxes mb ON mb.ROWID = m.mailbox
LEFT JOIN addresses a ON a.ROWID = m.sender
LEFT JOIN summaries sm ON sm.ROWID = m.summary`;

/** Gmail stores one row in All Mail plus label links; other servers may store copies per folder. Keep one row per message. */
const DEDUPE = `m.ROWID IN (SELECT min(ROWID) FROM messages WHERE deleted = 0 GROUP BY global_message_id)`;

async function buildWhere(input: SearchInput): Promise<{ where: string[]; params: (string | number)[] }> {
  const where = ["m.deleted = 0", DEDUPE];
  const params: (string | number)[] = [];
  let accountId: string | undefined;

  if (input.account) {
    accountId = (await resolveAccount(input.account)).id;
    where.push("mb.url LIKE ?");
    params.push(`%://${accountId}/%`);
  }
  if (input.mailbox) {
    const ids = (await resolveMailboxes(input.mailbox, accountId)).map((m) => m.rowid);
    const list = ids.join(",");
    where.push(
      `(m.global_message_id IN (SELECT x.global_message_id FROM messages x WHERE x.mailbox IN (${list}) AND x.deleted = 0)
        OR m.global_message_id IN (SELECT x.global_message_id FROM labels l JOIN messages x ON x.ROWID = l.message_id WHERE l.mailbox_id IN (${list})))`,
    );
  }
  for (const t of tokens(input.query ?? "")) {
    where.push(
      "(s.subject LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\' OR sm.summary LIKE ? ESCAPE '\\')",
    );
    const p = like(t);
    params.push(p, p, p, p);
  }
  if (input.from) {
    where.push("(a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')");
    params.push(like(input.from), like(input.from));
  }
  if (input.to) {
    where.push(
      `EXISTS (SELECT 1 FROM recipients r JOIN addresses ra ON ra.ROWID = r.address
               WHERE r.message = m.ROWID AND (ra.address LIKE ? ESCAPE '\\' OR ra.comment LIKE ? ESCAPE '\\'))`,
    );
    params.push(like(input.to), like(input.to));
  }
  if (input.subject) {
    where.push("s.subject LIKE ? ESCAPE '\\'");
    params.push(like(input.subject));
  }
  if (input.since) {
    where.push("m.date_received >= ?");
    params.push(parseDate(input.since));
  }
  if (input.before) {
    where.push("m.date_received < ?");
    params.push(parseDate(input.before));
  }
  if (input.unread !== undefined) where.push(input.unread ? "m.read = 0" : "m.read = 1");
  if (input.flagged !== undefined) where.push(input.flagged ? "m.flagged = 1" : "m.flagged = 0");
  if (input.hasAttachments !== undefined)
    where.push(`${input.hasAttachments ? "" : "NOT "}EXISTS (SELECT 1 FROM attachments at WHERE at.message = m.ROWID)`);
  return { where, params };
}

async function mailboxLabels(globalIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!globalIds.length) return out;
  const list = globalIds.join(",");
  const rows = getDb()
    .query<{ g: number; url: string }, []>(
      `SELECT x.global_message_id AS g, mb.url FROM messages x JOIN mailboxes mb ON mb.ROWID = x.mailbox
       WHERE x.global_message_id IN (${list}) AND x.deleted = 0
       UNION
       SELECT x.global_message_id AS g, mb.url FROM labels l JOIN messages x ON x.ROWID = l.message_id
       JOIN mailboxes mb ON mb.ROWID = l.mailbox_id WHERE x.global_message_id IN (${list})`,
    )
    .all();
  for (const r of rows) {
    const path = parseMailboxUrl(r.url).path;
    const arr = out.get(r.g) ?? [];
    if (!arr.includes(path)) arr.push(path);
    out.set(r.g, arr);
  }
  return out;
}

async function toRows(raw: RawRow[], snippetLen: number): Promise<MessageRow[]> {
  const labels = await mailboxLabels(raw.map((r) => r.global_message_id));
  const rows: MessageRow[] = [];
  for (const r of raw) {
    const { accountId } = parseMailboxUrl(r.mailbox_url);
    const row: MessageRow = {
      id: r.ROWID,
      date: new Date(r.date_received * 1000).toISOString(),
      from: r.comment ? `${r.comment} <${r.address}>` : (r.address ?? ""),
      subject: `${r.subject_prefix ?? ""}${r.subject}`,
      account: await accountName(accountId),
      mailboxes: labels.get(r.global_message_id) ?? [parseMailboxUrl(r.mailbox_url).path],
      unread: r.read === 0,
      flagged: r.flagged === 1,
      attachments: r.n_attach,
      conversation: r.conversation_id,
    };
    if (snippetLen > 0 && r.summary) row.snippet = r.summary.replace(/\s+/g, " ").slice(0, snippetLen);
    rows.push(row);
  }
  return rows;
}

export async function search(
  input: SearchInput,
  snippetLen = 160,
): Promise<{ total: number; offset: number; messages: MessageRow[] }> {
  const { where, params } = await buildWhere(input);
  const limit = Math.min(input.limit ?? 25, 500);
  const offset = input.offset ?? 0;
  const db = getDb();
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = db
    .query<{ n: number }, (string | number)[]>(
      `SELECT count(*) AS n FROM messages m JOIN subjects s ON s.ROWID = m.subject JOIN mailboxes mb ON mb.ROWID = m.mailbox
       LEFT JOIN addresses a ON a.ROWID = m.sender LEFT JOIN summaries sm ON sm.ROWID = m.summary ${clause}`,
    )
    .get(...params)!.n;
  const raw = db
    .query<RawRow, (string | number)[]>(`${SELECT} ${clause} ORDER BY m.date_received DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, offset, messages: await toRows(raw, snippetLen) };
}

/** Candidate rows for body scanning: same filters, but returns rowids and mailbox urls only. */
export async function candidates(input: SearchInput, cap: number): Promise<{ id: number; url: string }[]> {
  const { where, params } = await buildWhere(input);
  return getDb()
    .query<{ id: number; url: string }, (string | number)[]>(
      `SELECT m.ROWID AS id, mb.url FROM messages m JOIN subjects s ON s.ROWID = m.subject JOIN mailboxes mb ON mb.ROWID = m.mailbox
       LEFT JOIN addresses a ON a.ROWID = m.sender LEFT JOIN summaries sm ON sm.ROWID = m.summary
       WHERE ${where.join(" AND ")} ORDER BY m.date_received DESC LIMIT ?`,
    )
    .all(...params, cap);
}

export async function rowsByIds(ids: number[], snippetLen = 160): Promise<MessageRow[]> {
  if (!ids.length) return [];
  const raw = getDb()
    .query<RawRow, []>(`${SELECT} WHERE m.ROWID IN (${ids.map(Number).join(",")})`)
    .all();
  const byId = new Map(raw.map((r) => [r.ROWID, r]));
  return toRows(ids.map((id) => byId.get(id)).filter((r): r is RawRow => !!r), snippetLen);
}

export interface MessageLocation {
  rowid: number;
  mailboxUrl: string;
  accountId: string;
  mailboxPath: string;
  /** Every mailbox (folder or Gmail label) the message appears in. */
  allMailboxes: string[];
  conversation: number;
  summary: string | null;
}

export function locate(id: number): MessageLocation {
  const r = getDb()
    .query<{ url: string; g: number; c: number; summary: string | null }, [number]>(
      `SELECT mb.url, m.global_message_id AS g, m.conversation_id AS c, sm.summary FROM messages m
       JOIN mailboxes mb ON mb.ROWID = m.mailbox LEFT JOIN summaries sm ON sm.ROWID = m.summary WHERE m.ROWID = ?`,
    )
    .get(id);
  if (!r) throw new Error(`No message with id ${id}`);
  const { accountId, path } = parseMailboxUrl(r.url);
  const labels = getDb()
    .query<{ url: string }, [number]>(
      `SELECT mb.url FROM labels l JOIN mailboxes mb ON mb.ROWID = l.mailbox_id WHERE l.message_id = ?`,
    )
    .all(id)
    .map((x) => parseMailboxUrl(x.url).path);
  return {
    rowid: id,
    mailboxUrl: r.url,
    accountId,
    mailboxPath: path,
    allMailboxes: [path, ...labels.filter((l) => l !== path)],
    conversation: r.c,
    summary: r.summary,
  };
}

export function recipients(id: number): { to: string[]; cc: string[]; bcc: string[] } {
  const rows = getDb()
    .query<{ type: number; address: string; comment: string }, [number]>(
      `SELECT r.type, a.address, a.comment FROM recipients r JOIN addresses a ON a.ROWID = r.address
       WHERE r.message = ? ORDER BY r.type, r.position`,
    )
    .all(id);
  const fmt = (r: { address: string; comment: string }) => (r.comment ? `${r.comment} <${r.address}>` : r.address);
  return {
    to: rows.filter((r) => r.type === 0).map(fmt),
    cc: rows.filter((r) => r.type === 1).map(fmt),
    bcc: rows.filter((r) => r.type === 2).map(fmt),
  };
}

export function conversationIds(conversation: number): number[] {
  return getDb()
    .query<{ id: number }, [number]>(
      `SELECT m.ROWID AS id FROM messages m WHERE m.conversation_id = ? AND m.deleted = 0 AND ${DEDUPE}
       ORDER BY m.date_received ASC`,
    )
    .all(conversation)
    .map((r) => r.id);
}

export function rawQuery(sql: string, limit: number): unknown[] {
  if (!/^\s*(select|with|pragma\s+table_info)\b/i.test(sql)) throw new Error("Only SELECT / WITH queries are allowed");
  return getDb().query(sql).all().slice(0, limit);
}
