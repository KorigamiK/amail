#!/usr/bin/env bun
import { parseArgs, type ParseArgsConfig } from "node:util";
import * as ops from "./ops.ts";
import type { MessageRow } from "./db.ts";
import pkg from "../package.json" with { type: "json" };

const HELP = `amail — fast local Apple Mail CLI (reads Mail's on-disk index; writes via Mail.app)

Usage: amail <command> [args] [--json]

Read
  search [words...]        Search all accounts, newest first (no args = latest mail)
      --from, --to, --subject TEXT   substring filters
      -a, --account NAME             account name/email (substring ok)
      -m, --mailbox NAME             path or alias: inbox sent drafts trash spam archive important starred
      --since, --before DATE         2026-10-01 | "October 1, 2026" | 7d 24h 2w 3mo | today | yesterday
      --unread | --read, --flagged, --attachments
      --body TEXT                    also require TEXT in the full body (scans matches; --scan N caps, default 1000)
      -n, --limit N (25)  --offset N  --snippet N (chars, 0 = none)
  read <id...>             Full message(s): recipients, attachments, body
      --max-chars N (20000)  --strip-quotes  --html  --headers
  thread <id>              Whole conversation, oldest first, quotes stripped
      --max-chars N (4000)  --no-bodies
  attachments <id>         List attachments; --save [DIR] (default ~/Downloads), --name NAME (repeatable)
  accounts                 Accounts and mailboxes with counts
  sql "<SELECT ...>"       Read-only SQL on Mail's Envelope Index; --limit N (100)

Write (through Mail.app)
  mark <read|unread|flag|unflag> <id...>   [--color red|orange|yellow|green|blue|purple|gray]
  move <id...> --to MAILBOX
  archive <id...>
  delete <id...>                            moves to Trash
  draft   [--reply ID [--reply-all]] [--to A]... [--cc A]... [--bcc A]... [--subject S]
          (--body TEXT | --body-file PATH | --body-file - for stdin) [--from ACCOUNT] [--attach PATH]...
          Opens the message in Mail.app and saves it to Drafts.
  send    same options as draft, but sends immediately.

Global
  --json   machine-readable output
  -h, --help
  -v, --version

Ids are Mail message ids as printed by search/read/thread (#12345 -> 12345).`;

const COMMON = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

const SPECS = {
  search: {
    from: { type: "string" },
    to: { type: "string" },
    subject: { type: "string" },
    account: { type: "string", short: "a" },
    mailbox: { type: "string", short: "m" },
    since: { type: "string" },
    before: { type: "string" },
    unread: { type: "boolean" },
    read: { type: "boolean" },
    flagged: { type: "boolean" },
    attachments: { type: "boolean" },
    body: { type: "string" },
    scan: { type: "string" },
    limit: { type: "string", short: "n" },
    offset: { type: "string" },
    snippet: { type: "string" },
  },
  read: {
    "max-chars": { type: "string" },
    "strip-quotes": { type: "boolean" },
    html: { type: "boolean" },
    headers: { type: "boolean" },
  },
  thread: { "max-chars": { type: "string" }, "no-bodies": { type: "boolean" } },
  attachments: { save: { type: "string" }, name: { type: "string", multiple: true } },
  accounts: {},
  sql: { limit: { type: "string" } },
  mark: { color: { type: "string" } },
  move: { to: { type: "string" } },
  archive: {},
  delete: {},
  draft: {
    reply: { type: "string" },
    "reply-all": { type: "boolean" },
    to: { type: "string", multiple: true },
    cc: { type: "string", multiple: true },
    bcc: { type: "string", multiple: true },
    subject: { type: "string" },
    body: { type: "string" },
    "body-file": { type: "string" },
    from: { type: "string" },
    attach: { type: "string", multiple: true },
  },
} as const satisfies Record<string, ParseArgsConfig["options"]>;

type Command = keyof typeof SPECS | "send";

class UsageError extends Error {}

const int = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer`);
  return n;
};

const ids = (args: string[]): number[] => {
  if (!args.length) throw new UsageError("At least one message id is required");
  return args.map((a) => {
    const n = Number(a.replace(/^#/, ""));
    if (!Number.isInteger(n)) throw new UsageError(`Invalid message id "${a}"`);
    return n;
  });
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const shortMailboxes = (mbs: string[]) => {
  const meaningful = mbs.filter((m) => !/all mail$/i.test(m));
  return (meaningful.length ? meaningful : mbs).map((m) => m.replace(/^\[Gmail\]\//, "")).join(",");
};

function printRows(rows: MessageRow[]) {
  for (const r of rows) {
    const marks = `${r.unread ? "●" : " "}${r.flagged ? "⚑" : " "}`;
    const att = r.attachments ? `  [${r.attachments} att]` : "";
    console.log(`#${r.id} ${marks} ${fmtDate(r.date)}  ${r.from}`);
    console.log(`        ${r.subject}${att}  (${r.account} · ${shortMailboxes(r.mailboxes)})`);
    if (r.snippet) console.log(`        ${r.snippet}`);
  }
}

function printMessage(m: ops.FullMessage) {
  const line = (k: string, v?: string | string[]) => {
    const s = Array.isArray(v) ? v.join(", ") : v;
    if (s) console.log(`${k.padEnd(9)}${s}`);
  };
  console.log(`── #${m.id} ${"─".repeat(60)}`);
  line("Date:", fmtDate(m.date));
  line("From:", m.from);
  line("To:", m.to);
  line("Cc:", m.cc);
  line("Bcc:", m.bcc);
  line("Reply-To:", m.replyTo);
  line("Subject:", m.subject);
  line("Mailbox:", `${m.account} · ${m.mailboxes.join(", ")}${m.unread ? " · unread" : ""}${m.flagged ? " · flagged" : ""}`);
  for (const a of m.attachments)
    line("Attach:", `${a.name} (${a.mimeType}, ${a.notDownloaded ? "not downloaded" : `${Math.ceil(a.size / 1024)} KB`})`);
  if (m.headers) for (const [k, v] of Object.entries(m.headers)) line(`${k}:`, v);
  if (m.bodySource === "index-preview") console.log("(full message not downloaded locally; showing index preview)");
  console.log(`\n${m.body}\n`);
}

async function readBody(v: Record<string, unknown>): Promise<string> {
  if (typeof v.body === "string") return v.body;
  const file = v["body-file"];
  if (typeof file === "string") return file === "-" ? await Bun.stdin.text() : await Bun.file(ops.expandHome(file)).text();
  throw new UsageError("--body or --body-file is required");
}

async function run(argv: string[]): Promise<void> {
  const cmd = argv[0] as Command | undefined;
  if (cmd === ("--version" as Command) || cmd === ("-v" as Command) || cmd === ("version" as Command)) {
    console.log(pkg.version);
    return;
  }
  if (!cmd || cmd === ("-h" as Command) || cmd === ("--help" as Command) || cmd === ("help" as Command)) {
    console.log(HELP);
    return;
  }
  const specKey = cmd === "send" ? "draft" : cmd;
  if (!(specKey in SPECS)) throw new UsageError(`Unknown command "${cmd}"`);
  const { values: v, positionals: pos } = parseArgs({
    args: argv.slice(1),
    options: { ...COMMON, ...SPECS[specKey as keyof typeof SPECS] },
    allowPositionals: true,
    strict: true,
  }) as { values: Record<string, any>; positionals: string[] };
  if (v.help) {
    console.log(HELP);
    return;
  }
  const out = (data: unknown, human: () => void) => (v.json ? console.log(JSON.stringify(data, null, 2)) : human());

  switch (cmd) {
    case "search": {
      if (v.unread && v.read) throw new UsageError("--unread and --read are mutually exclusive");
      const res = await ops.search({
        query: pos.join(" ") || undefined,
        from: v.from,
        to: v.to,
        subject: v.subject,
        account: v.account,
        mailbox: v.mailbox,
        since: v.since,
        before: v.before,
        unread: v.unread ? true : v.read ? false : undefined,
        flagged: v.flagged,
        hasAttachments: v.attachments,
        bodyContains: v.body,
        scanLimit: int(v.scan, "scan"),
        limit: int(v.limit, "limit"),
        offset: int(v.offset, "offset"),
        snippet: int(v.snippet, "snippet") ?? (v.json ? 160 : 0),
      });
      return out(res, () => {
        printRows(res.messages);
        const shown = res.offset + res.messages.length;
        const scan = res.scan
          ? ` · body scan ${res.scan.scanned}/${res.scan.candidates}${res.scan.complete ? "" : " (incomplete, raise --scan)"}`
          : "";
        console.log(res.messages.length ? `\n${res.offset + 1}–${shown} of ${res.total}${scan}` : `No messages${scan}`);
      });
    }
    case "read": {
      const opts = {
        maxChars: int(v["max-chars"], "max-chars"),
        stripQuotes: v["strip-quotes"],
        html: v.html,
        headers: v.headers,
      };
      const msgs = await Promise.all(ids(pos).map((id) => ops.read(id, opts)));
      return out(msgs, () => msgs.forEach(printMessage));
    }
    case "thread": {
      const [id] = ids(pos);
      if (v["no-bodies"]) {
        const rows = (await ops.thread(id!, { bodies: false })) as MessageRow[];
        return out(rows, () => printRows(rows));
      }
      const msgs = (await ops.thread(id!, { maxChars: int(v["max-chars"], "max-chars") })) as ops.FullMessage[];
      return out(msgs, () => msgs.forEach(printMessage));
    }
    case "attachments": {
      const [id] = ids(pos);
      if (v.save !== undefined || v.name) {
        const res = await ops.saveAttachments(id!, v.save || undefined, v.name);
        return out(res, () => {
          res.saved.forEach((p) => console.log(`saved  ${p}`));
          res.notDownloaded.forEach((n) => console.log(`skipped ${n} (not downloaded yet; open the message in Mail)`));
        });
      }
      const list = await ops.attachments(id!);
      return out(list, () => {
        if (!list.length) console.log("No attachments");
        for (const a of list)
          console.log(`${a.name}  ${a.mimeType}  ${a.notDownloaded ? "not downloaded" : `${Math.ceil(a.size / 1024)} KB`}`);
      });
    }
    case "accounts": {
      const accts = await ops.accounts();
      return out(accts, () => {
        for (const a of accts) {
          console.log(`${a.name}  <${a.emails.join(", ")}>`);
          for (const m of a.mailboxes) console.log(`    ${m.path.padEnd(28)} ${String(m.total).padStart(7)} total  ${m.unread} unread`);
        }
      });
    }
    case "sql": {
      if (!pos[0]) throw new UsageError("sql needs a query string");
      const rows = ops.sql(pos.join(" "), int(v.limit, "limit") ?? 100);
      return out(rows, () => (rows.length ? console.table(rows) : console.log("No rows")));
    }
    case "mark": {
      const [what, ...rest] = pos;
      if (!["read", "unread", "flag", "unflag"].includes(what ?? ""))
        throw new UsageError("mark needs one of: read, unread, flag, unflag");
      if (v.color && !ops.FLAG_COLORS.includes(v.color)) throw new UsageError(`--color must be one of ${ops.FLAG_COLORS.join(", ")}`);
      return report(await ops.update(ids(rest), what as ops.UpdateAction, { color: v.color }), v.json);
    }
    case "move":
      if (!v.to) throw new UsageError("move needs --to MAILBOX");
      return report(await ops.update(ids(pos), "move", { mailbox: v.to }), v.json);
    case "archive":
      return report(await ops.update(ids(pos), "archive"), v.json);
    case "delete":
      return report(await ops.update(ids(pos), "delete"), v.json);
    case "draft":
    case "send": {
      const res = await ops.composeMessage({
        body: await readBody(v),
        subject: v.subject,
        to: v.to,
        cc: v.cc,
        bcc: v.bcc,
        replyTo: v.reply ? ids([v.reply])[0] : undefined,
        replyAll: v["reply-all"],
        from: v.from,
        attachments: v.attach,
        send: cmd === "send",
      });
      return out(res, () =>
        console.log(res.status === "sent" ? `Sent: ${res.subject}` : `Draft saved and open in Mail.app: ${res.subject}`),
      );
    }
  }
}

function report(r: Awaited<ReturnType<typeof ops.update>>, json: boolean) {
  if (json) return console.log(JSON.stringify(r, null, 2));
  if (r.ok.length) console.log(`${r.action}: ${r.ok.map((i) => `#${i}`).join(" ")}`);
  if (r.skipped.length) console.log(`already there: ${r.skipped.map((i) => `#${i}`).join(" ")}`);
  for (const f of r.failed) console.error(`failed #${f.rowid}: ${f.error}`);
  if (r.failed.length) process.exitCode = 1;
}

try {
  await run(process.argv.slice(2));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`amail: ${msg}`);
  if (e instanceof UsageError || /Unknown option|Unexpected argument|requires a value/i.test(msg))
    console.error("Run `amail --help` for usage.");
  process.exit(e instanceof UsageError ? 2 : 1);
}
