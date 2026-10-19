export interface Account {
  id: string;
  name: string;
  emails: string[];
  fullName: string;
}

export async function osa(script: string, timeoutMs = 60_000): Promise<string> {
  const proc = Bun.spawn(["osascript", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(script);
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`AppleScript failed: ${err.trim() || `exit ${code}`}`);
  return out.replace(/\n$/, "");
}

/** Quotes a JS string as an AppleScript string literal. */
export function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

let accountsCache: Account[] | null = null;

export async function listAccounts(): Promise<Account[]> {
  if (accountsCache) return accountsCache;
  const out = await osa(`
set AppleScript's text item delimiters to ","
set out to ""
tell application "Mail"
  repeat with a in every account
    set fn to ""
    try
      set fn to full name of a
    end try
    set out to out & (id of a) & tab & (name of a) & tab & ((email addresses of a) as text) & tab & fn & linefeed
  end repeat
end tell
return out`);
  accountsCache = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", name = "", emails = "", fullName = ""] = line.split("\t");
      return { id, name, emails: emails.split(",").filter(Boolean), fullName: fullName.trim() };
    });
  return accountsCache;
}

export interface MessageRef {
  rowid: number;
  accountId: string;
  mailboxPath: string;
}

function messageRef(ref: MessageRef): string {
  return `(first message of mailbox ${q(ref.mailboxPath)} of (first account whose id is ${q(ref.accountId)}) whose id is ${ref.rowid})`;
}

export type MessageAction =
  | { kind: "read"; value: boolean }
  | { kind: "flag"; value: boolean; color?: number }
  | { kind: "move"; mailbox: string; accountId?: string }
  | { kind: "delete" };

function actionScript(ref: MessageRef, action: MessageAction): string {
  const m = "m";
  switch (action.kind) {
    case "read":
      return `set read status of ${m} to ${action.value}`;
    case "flag":
      if (!action.value) return `set flagged status of ${m} to false`;
      return action.color === undefined
        ? `set flagged status of ${m} to true`
        : `set flagged status of ${m} to true\nset flag index of ${m} to ${action.color}`;
    case "move": {
      const acct = action.accountId ?? ref.accountId;
      return `move ${m} to mailbox ${q(action.mailbox)} of (first account whose id is ${q(acct)})`;
    }
    case "delete":
      return `delete ${m}`;
  }
}

/** Applies one action to many messages in a single osascript call; returns per-message errors. */
export async function applyAction(
  refs: MessageRef[],
  action: MessageAction,
): Promise<{ ok: number[]; failed: { rowid: number; error: string }[] }> {
  const blocks = refs
    .map(
      (ref) => `
try
  set m to ${messageRef(ref)}
  ${actionScript(ref, action)}
  set out to out & "ok" & tab & ${ref.rowid} & linefeed
on error e
  set out to out & "err" & tab & ${ref.rowid} & tab & e & linefeed
end try`,
    )
    .join("\n");
  const out = await osa(`set out to ""\ntell application "Mail"\n${blocks}\nend tell\nreturn out`, 120_000);
  const ok: number[] = [];
  const failed: { rowid: number; error: string }[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [status, id, err] = line.split("\t");
    if (status === "ok") ok.push(Number(id));
    else failed.push({ rowid: Number(id), error: err ?? "unknown error" });
  }
  return { ok, failed };
}

export interface ComposeInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  from?: string;
  attachments?: string[];
  replyTo?: MessageRef;
  replyAll?: boolean;
  send: boolean;
}

/**
 * Creates (and optionally sends) a message. Without `send`, the compose window is left open
 * and saved to Drafts so the user can review it.
 */
export async function compose(input: ComposeInput): Promise<string> {
  return osa(composeScript(input), 120_000);
}

export function composeScript(input: ComposeInput): string {
  const recips = (kind: string, list?: string[]) =>
    (list ?? [])
      .map((addr) => `make new ${kind} recipient at end of ${kind} recipients with properties {address:${q(addr)}}`)
      .join("\n    ");
  const attach = (input.attachments ?? [])
    .map(
      (p) =>
        `make new attachment with properties {file name:(POSIX file ${q(p)}) as alias} at after the last paragraph`,
    )
    .join("\n      ");

  const create = input.replyTo
    ? `set src to ${messageRef(input.replyTo)}
  set msg to reply src with opening window${input.replyAll ? " and reply to all" : ""}
  delay 0.5
  set oldContent to content of msg
  set content of msg to ${q(input.body)} & return & return & oldContent`
    : `set msg to make new outgoing message with properties {subject:${q(input.subject ?? "")}, content:${q(input.body)}, visible:true}`;

  return `
tell application "Mail"
  ${create}
  tell msg
    ${input.replyTo && input.subject ? `set subject to ${q(input.subject)}` : ""}
    ${recips("to", input.to)}
    ${recips("cc", input.cc)}
    ${recips("bcc", input.bcc)}
    ${input.from ? `set sender to ${q(input.from)}` : ""}
    ${attach ? `tell content\n      ${attach}\n    end tell` : ""}
  end tell
  set subj to subject of msg
  ${input.send ? "send msg" : "save msg"}
  return subj
end tell`;
}
