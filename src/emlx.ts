import PostalMime, { type Email } from "postal-mime";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { attachmentsDir, findEmlx } from "./paths.ts";

/** .emlx = "<byte count>\n" + RFC 822 bytes + Apple plist trailer. */
export async function readRfc822(path: string): Promise<Uint8Array> {
  const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
  const nl = buf.indexOf(0x0a);
  const len = Number(new TextDecoder().decode(buf.subarray(0, nl)).trim());
  return Number.isFinite(len) && len > 0 ? buf.subarray(nl + 1, nl + 1 + len) : buf.subarray(nl + 1);
}

export async function parseMessage(mailboxUrl: string, rowid: number): Promise<{ email: Email; partial: boolean } | null> {
  const loc = findEmlx(mailboxUrl, rowid);
  if (!loc) return null;
  const raw = await readRfc822(loc.path);
  return { email: await PostalMime.parse(raw), partial: loc.partial };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return t && t !== href && !href.startsWith("mailto:") ? `${t} (${href})` : t || href;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drops quoted reply history ("On ... wrote:" and "> " lines) so threads don't repeat themselves. */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex(
    (l, i) =>
      /^On .{5,200}wrote:\s*$/.test(l) ||
      (/^On .{5,200}$/.test(l) && /wrote:\s*$/.test(lines[i + 1] ?? "")) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(l) ||
      /^From: .+$/.test(l) && /^(Sent|Date): /.test(lines[i + 1] ?? ""),
  );
  const kept = cut > 0 ? lines.slice(0, cut) : lines;
  return kept.filter((l) => !/^>/.test(l)).join("\n").trim();
}

export interface AttachmentInfo {
  name: string;
  mimeType: string;
  size: number;
  /** Absolute path when Mail has the attachment stored as a separate file (partial downloads). */
  path?: string;
  /** Mail hasn't fetched this part from the server yet (open the message in Mail.app to download it). */
  notDownloaded?: boolean;
}

export function storedAttachments(mailboxUrl: string, rowid: number): AttachmentInfo[] {
  const dir = attachmentsDir(mailboxUrl, rowid);
  if (!dir) return [];
  const out: AttachmentInfo[] = [];
  for (const part of readdirSync(dir)) {
    const partDir = join(dir, part);
    if (!existsSync(partDir)) continue;
    for (const name of readdirSync(partDir)) {
      const p = join(partDir, name);
      const f = Bun.file(p);
      out.push({ name, mimeType: f.type, size: f.size, path: p });
    }
  }
  return out;
}

export type LoadedAttachment = AttachmentInfo & { content?: ArrayBuffer | Uint8Array | string };

/** Attachments from both the message body and Mail's separate Attachments folder, de-duplicated by name. */
export function allAttachments(email: Email | null, mailboxUrl: string, rowid: number): LoadedAttachment[] {
  const stored = storedAttachments(mailboxUrl, rowid);
  const names = new Set(stored.map((a) => a.name));
  const inline: LoadedAttachment[] = email
    ? emailAttachments(email)
        .filter((a) => !names.has(a.name))
        .map((a) => (a.size > 0 ? a : { name: a.name, mimeType: a.mimeType, size: 0, notDownloaded: true }))
    : [];
  const seen = new Set<string>();
  return [...stored, ...inline].filter((a) => {
    const key = `${a.name}:${a.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emailAttachments(email: Email): (AttachmentInfo & { content: ArrayBuffer | Uint8Array | string })[] {
  return email.attachments
    .filter((a) => a.disposition !== "inline" || a.filename)
    .map((a, i) => ({
      name: a.filename ?? `attachment-${i + 1}`,
      mimeType: a.mimeType,
      size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
      content: a.content,
    }));
}
