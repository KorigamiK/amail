import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAIL_ROOT = join(homedir(), "Library", "Mail");

export function mailDataDir(): string {
  if (process.env.AMAIL_DATA_DIR) return process.env.AMAIL_DATA_DIR;
  const versions = readdirSync(MAIL_ROOT)
    .filter((d) => /^V\d+$/.test(d))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  if (!versions[0]) throw new Error(`No Mail data directory (V*) found in ${MAIL_ROOT}`);
  return join(MAIL_ROOT, versions[0]);
}

export function envelopeIndexPath(): string {
  return join(mailDataDir(), "MailData", "Envelope Index");
}

/** Splits a mailbox url like imap://UUID/%5BGmail%5D/All%20Mail into account UUID and decoded path. */
export function parseMailboxUrl(url: string): { accountId: string; path: string; local: boolean } {
  const m = url.match(/^(\w+):\/\/([^/]+)\/(.*)$/);
  if (!m) return { accountId: "", path: url, local: false };
  return { accountId: m[2]!, path: decodeURIComponent(m[3]!), local: m[1] === "local" };
}

const storeDirCache = new Map<string, string | null>();

/** Directory such as .../[Gmail].mbox/All Mail.mbox/<store-uuid> that holds Data/ for a mailbox. */
export function mailboxStoreDir(url: string): string | null {
  if (storeDirCache.has(url)) return storeDirCache.get(url)!;
  const { accountId, path } = parseMailboxUrl(url);
  const mboxDir = join(mailDataDir(), accountId, ...path.split("/").map((s) => `${s}.mbox`));
  let result: string | null = null;
  if (existsSync(mboxDir)) {
    const store = readdirSync(mboxDir, { withFileTypes: true }).find(
      (d) => d.isDirectory() && /^[0-9A-F-]{36}$/i.test(d.name),
    );
    result = store ? join(mboxDir, store.name) : existsSync(join(mboxDir, "Messages")) ? mboxDir : null;
  }
  storeDirCache.set(url, result);
  return result;
}

/** Mail shards messages by floor(rowid / 1000), digits reversed: 12345 -> Data/2/1. */
export function dataShardDir(storeDir: string, rowid: number): string {
  const n = Math.floor(rowid / 1000);
  const digits = n === 0 ? [] : String(n).split("").reverse();
  return join(storeDir, "Data", ...digits);
}

export function findEmlx(mailboxUrl: string, rowid: number): { path: string; partial: boolean } | null {
  const store = mailboxStoreDir(mailboxUrl);
  if (!store) return null;
  const dir = join(dataShardDir(store, rowid), "Messages");
  for (const [name, partial] of [
    [`${rowid}.emlx`, false],
    [`${rowid}.partial.emlx`, true],
  ] as const) {
    const p = join(dir, name);
    if (existsSync(p)) return { path: p, partial };
  }
  return null;
}

export function attachmentsDir(mailboxUrl: string, rowid: number): string | null {
  const store = mailboxStoreDir(mailboxUrl);
  if (!store) return null;
  const dir = join(dataShardDir(store, rowid), "Attachments", String(rowid));
  return existsSync(dir) ? dir : null;
}
