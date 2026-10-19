import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as db from "./db.ts";
import { applyAction, compose, listAccounts, type MessageAction, type MessageRef } from "./applescript.ts";
import { allAttachments, htmlToText, parseMessage, stripQuoted, type AttachmentInfo } from "./emlx.ts";

export const expandHome = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

export async function accounts() {
  const [accts, mailboxes] = await Promise.all([listAccounts(), db.getMailboxes()]);
  return accts.map((a) => ({
    ...a,
    mailboxes: mailboxes
      .filter((m) => m.accountId === a.id)
      .map((m) => ({ path: m.path, total: m.total, unread: m.unread })),
  }));
}

export interface SearchOptions extends db.SearchInput {
  bodyContains?: string;
  scanLimit?: number;
  snippet?: number;
}

export interface SearchResult {
  total: number;
  offset: number;
  messages: db.MessageRow[];
  /** Present when bodyContains was used. */
  scan?: { scanned: number; candidates: number; complete: boolean };
}

export async function search(o: SearchOptions): Promise<SearchResult> {
  const snippetLen = o.snippet ?? 160;
  if (!o.bodyContains) return db.search(o, snippetLen);
  const needle = o.bodyContains.toLowerCase();
  const limit = o.limit ?? 25;
  const offset = o.offset ?? 0;
  const cands = await db.candidates(o, o.scanLimit ?? 1000);
  const hits: number[] = [];
  let scanned = 0;
  for (const c of cands) {
    if (hits.length >= limit + offset) break;
    scanned++;
    const parsed = await parseMessage(c.url, c.id).catch(() => null);
    if (!parsed) continue;
    const { text, html } = parsed.email;
    if (`${text ?? ""}\n${html ? htmlToText(html) : ""}`.toLowerCase().includes(needle)) hits.push(c.id);
  }
  return {
    total: hits.length,
    offset,
    messages: await db.rowsByIds(hits.slice(offset, offset + limit), snippetLen),
    scan: { scanned, candidates: cands.length, complete: scanned === cands.length },
  };
}

export interface ReadOptions {
  maxChars?: number;
  stripQuotes?: boolean;
  html?: boolean;
  headers?: boolean;
}

export interface FullMessage extends Omit<db.MessageRow, "attachments" | "snippet"> {
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string[];
  messageId?: string;
  headers?: Record<string, string>;
  attachments: AttachmentInfo[];
  body: string;
  bodySource: "message" | "index-preview";
  truncated: boolean;
}

export async function read(id: number, o: ReadOptions = {}): Promise<FullMessage> {
  const maxChars = o.maxChars ?? 20_000;
  const loc = db.locate(id);
  const [row] = await db.rowsByIds([id], 0);
  if (!row) throw new Error(`No message with id ${id}`);
  const { attachments: _n, snippet: _s, ...base } = row;
  const parsed = await parseMessage(loc.mailboxUrl, id).catch(() => null);
  const attachments = allAttachments(parsed?.email ?? null, loc.mailboxUrl, id).map(({ content, ...rest }) => rest);
  const common = { ...base, ...db.recipients(id), attachments };
  if (!parsed) {
    return { ...common, body: loc.summary ?? "", bodySource: "index-preview", truncated: false };
  }
  const { email } = parsed;
  let body = o.html && email.html ? email.html : (email.text ?? (email.html ? htmlToText(email.html) : ""));
  if (o.stripQuotes && !o.html) body = stripQuoted(body);
  body = body.trim();
  const truncated = body.length > maxChars;
  return {
    ...common,
    replyTo: email.replyTo?.map((r) => (r.name ? `${r.name} <${r.address ?? ""}>` : (r.address ?? ""))),
    messageId: email.messageId,
    ...(o.headers ? { headers: Object.fromEntries(email.headers.map((h) => [h.key, h.value])) } : {}),
    body: truncated ? `${body.slice(0, maxChars)}\n…[truncated ${body.length - maxChars} chars]` : body,
    bodySource: "message",
    truncated,
  };
}

export async function thread(id: number, o: { maxChars?: number; bodies?: boolean } = {}) {
  const ids = db.conversationIds(db.locate(id).conversation);
  if (o.bodies === false) return db.rowsByIds(ids, 160);
  return Promise.all(ids.map((i) => read(i, { maxChars: o.maxChars ?? 4000, stripQuotes: true })));
}

export async function attachments(id: number) {
  const loc = db.locate(id);
  const parsed = await parseMessage(loc.mailboxUrl, id).catch(() => null);
  return allAttachments(parsed?.email ?? null, loc.mailboxUrl, id).map(({ content, ...rest }) => rest);
}

export async function saveAttachments(id: number, dirArg?: string, names?: string[]) {
  const loc = db.locate(id);
  const dir = expandHome(dirArg ?? "~/Downloads");
  mkdirSync(dir, { recursive: true });
  const want = (n: string) => !names?.length || names.includes(n);
  const saved: string[] = [];
  const notDownloaded: string[] = [];
  const parsed = await parseMessage(loc.mailboxUrl, id).catch(() => null);
  for (const att of allAttachments(parsed?.email ?? null, loc.mailboxUrl, id)) {
    if (!want(att.name)) continue;
    const p = join(dir, att.name);
    if (att.path) await Bun.write(p, Bun.file(att.path));
    else if (att.content !== undefined) await Bun.write(p, att.content);
    else {
      notDownloaded.push(att.name);
      continue;
    }
    saved.push(p);
  }
  if (!saved.length && !notDownloaded.length) throw new Error("No matching attachments for this message");
  return { saved, notDownloaded };
}

export const FLAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];
export type UpdateAction = "read" | "unread" | "flag" | "unflag" | "move" | "archive" | "delete";

export async function update(ids: number[], action: UpdateAction, opts: { mailbox?: string; color?: FlagColor } = {}) {
  const groups = new Map<string, { refs: MessageRef[]; action: MessageAction }>();
  const skipped: number[] = [];
  for (const id of ids) {
    const loc = db.locate(id);
    let ref: MessageRef = { rowid: loc.rowid, accountId: loc.accountId, mailboxPath: loc.mailboxPath };
    let act: MessageAction;
    switch (action) {
      case "read":
      case "unread":
        act = { kind: "read", value: action === "read" };
        break;
      case "flag":
      case "unflag":
        act = {
          kind: "flag",
          value: action === "flag",
          color: opts.color ? FLAG_COLORS.indexOf(opts.color) : undefined,
        };
        break;
      case "delete":
        act = { kind: "delete" };
        break;
      case "move": {
        if (!opts.mailbox) throw new Error("A destination mailbox is required for move");
        const [dest] = await db.resolveMailboxes(opts.mailbox, loc.accountId);
        act = { kind: "move", mailbox: dest!.path };
        break;
      }
      case "archive": {
        const [dest] = await db.resolveMailboxes("archive", loc.accountId);
        if (!dest) throw new Error("No archive mailbox for this account");
        // Gmail keeps the message in All Mail; archiving = moving it out of INBOX (removing the label).
        const inbox = loc.allMailboxes.find((p) => /^inbox$/i.test(p));
        if (inbox) ref = { ...ref, mailboxPath: inbox };
        if (ref.mailboxPath === dest.path) {
          skipped.push(id);
          continue;
        }
        act = { kind: "move", mailbox: dest.path };
        break;
      }
    }
    const key = JSON.stringify(act);
    const g = groups.get(key) ?? { refs: [], action: act };
    g.refs.push(ref);
    groups.set(key, g);
  }
  const ok: number[] = [];
  const failed: { rowid: number; error: string }[] = [];
  for (const g of groups.values()) {
    const r = await applyAction(g.refs, g.action);
    ok.push(...r.ok);
    failed.push(...r.failed);
  }
  return { action, ok, failed, skipped };
}

export interface ComposeOptions {
  body: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: number;
  replyAll?: boolean;
  from?: string;
  attachments?: string[];
  send: boolean;
}

export async function composeMessage(o: ComposeOptions) {
  if (!o.replyTo && !o.to?.length) throw new Error("--to is required for new messages");
  if (!o.replyTo && !o.subject) throw new Error("--subject is required for new messages");
  let replyTo: MessageRef | undefined;
  if (o.replyTo) {
    const loc = db.locate(o.replyTo);
    replyTo = { rowid: loc.rowid, accountId: loc.accountId, mailboxPath: loc.mailboxPath };
  }
  let from: string | undefined;
  if (o.from && o.from.includes("<")) from = o.from;
  else if (o.from) {
    // Mail matches the sender string against the account's "Full Name <address>" entries; a bare address drops the name.
    const acct = await db.resolveAccount(o.from);
    const address = o.from.includes("@") ? o.from : acct.emails[0];
    from = acct.fullName ? `${acct.fullName} <${address}>` : address;
  }
  const subject = await compose({
    ...o,
    from,
    replyTo,
    attachments: o.attachments?.map(expandHome),
  });
  return { status: o.send ? "sent" : "draft", subject };
}

export const sql = db.rawQuery;
