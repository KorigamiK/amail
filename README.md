# amail

A fast command-line tool for Apple Mail, for both people and coding agents.

`amail` reads Mail.app's own local data instead of driving the Mail UI. Searches cover every account and mailbox at once, with no size limit, and usually finish well under a second. Changes such as marking, moving, drafting and sending still go through Mail.app, so they sync to your server like normal edits.

```sh
amail search invoice --since 30d             # all accounts, newest first
amail search -m inbox --unread -a work       # unread in one account's inbox
amail search --from github --attachments
amail read 12345                             # recipients, attachments, plain-text body
amail thread 12345                           # whole conversation, quoted text stripped
amail attachments 12345 --save ~/Downloads
amail mark read 12345 12346
amail archive 12345
amail draft --reply 12345 --body-file reply.txt   # opens in Mail.app, saved to Drafts
amail --help
```

Add `--json` to any command for machine-readable output.

## How it works

- **Search and listing** query `~/Library/Mail/V*/MailData/Envelope Index`, the SQLite database Mail keeps for itself. It's opened read-only. A Gmail message that carries several labels shows up once, with all its labels listed.
- **Reading** parses the message's `.emlx` file on disk: headers, recipients, a text body (HTML is converted to text) and attachments.
- **Writes** run AppleScript against Mail.app. `draft` opens the compose window and saves it to Drafts. `send` sends immediately.
- **`amail sql "SELECT …"`** runs read-only SQL queries for anything the built-in commands don't cover.

## Install

```sh
brew install korigamik/tap/amail
```

Or from source, with [Bun](https://bun.sh):

```sh
git clone https://github.com/KorigamiK/amail && cd amail
bun install
ln -s "$PWD/src/cli.ts" ~/.local/bin/amail
```

### Permissions

- **Full Disk Access** for your terminal app (or whichever app runs `amail`), so it can read `~/Library/Mail`. Turn it on in System Settings → Privacy & Security → Full Disk Access.
- **Automation → Mail**. macOS asks for this the first time you run a write command such as `mark`, `move`, `draft` or `send`.

## Using it with coding agents

`skills/amail/SKILL.md` is an [agent skill](https://agentskills.io) that explains to agents when and how to use `amail`. It tells them to create drafts by default and to send only when you explicitly ask. Symlink it into the skills folder each agent reads at the user level:

| Agent | Reads user skills from |
| --- | --- |
| Codex | `~/.agents/skills` |
| opencode | `~/.agents/skills`, `~/.claude/skills`, `~/.config/opencode/skills` |
| Claude Code | `~/.claude/skills` only |

Two links cover all three. `~/.agents/skills` covers Codex and opencode, and `~/.claude/skills` covers Claude Code, which doesn't read `.agents`. opencode sees both links, but it loads a skill by its ID only once, so this doesn't create a duplicate. Don't also add it to `~/.config/opencode/skills` or `~/.codex/skills`.

```sh
skill="$(brew --prefix)/share/amail/skills/amail"   # or "$PWD/skills/amail" for a source checkout
mkdir -p ~/.agents/skills ~/.claude/skills
ln -sfn "$skill" ~/.agents/skills/amail    # Codex + opencode
ln -sfn "$skill" ~/.claude/skills/amail    # Claude Code
```

If you used an Apple Mail MCP server before, remove it so agents don't have two ways to reach your mail:
- **Claude Code:** `claude mcp remove <name>`
- **Codex:** delete its `[mcp_servers.<name>]` block from `~/.codex/config.toml`
- **opencode:** delete its entry under `mcp` in `opencode.json`

If your agent lets you require approval for shell commands, require it for `amail send`, `amail delete`, `amail move` and `amail archive`.

## Notes

- Requires macOS with Mail.app set up. Tested on macOS 26 with the `V10` data layout. To use a different data directory, set `AMAIL_DATA_DIR`.
- If Mail hasn't downloaded a body or attachment yet, `amail` reports it as `not downloaded` or shows the index preview. Open the message in Mail.app to fetch it.
- The index only updates after Mail syncs, so a change you make may take a moment to show up in `search`.

## License

MIT
