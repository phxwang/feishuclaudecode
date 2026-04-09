# Feishu Channel for Claude Code

A [Feishu (Lark)](https://www.feishu.cn/) channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), built on Claude Code's **native [Channel interface](https://docs.anthropic.com/en/docs/claude-code/channels)**. Send messages to a Feishu bot and interact with Claude — right in your chat.

Uses the MCP Channel protocol to integrate Feishu as a first-class messaging channel for Claude Code, with **WebSocket persistent connection** mode requiring no public HTTPS endpoint.

## Features

- **Direct messages** — Chat with Claude through Feishu DMs
- **Group chats** — Add the bot to group chats with @mention support
- **Access control** — Pairing-based onboarding, allowlists, and per-group policies
- **Confirm cards** — Interactive confirmation cards for risky actions
- **Permission cards** — Interactive approve/deny cards for tool permission requests
- **Attachments** — Send and receive files and images
- **Reactions** — Configurable emoji reactions on message receipt
- **Smart connection** — Only connects to Feishu WebSocket when launched as a channel, avoiding unnecessary connections from non-channel Claude instances
- **Graceful shutdown** — Detects parent process exit via ppid polling, preventing orphaned processes and 100% CPU loops

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- A Feishu (or Lark) workspace with admin access to create apps

## Quick Start

### 1. Create a Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn) (or [Lark Open Platform](https://open.larksuite.com) for international)
2. Create a **Custom App** (enterprise internal app)
3. Note the **App ID** (`cli_...`) and **App Secret**
4. Under **Events & Callbacks**, configure two separate tabs:

   **Event Configuration** tab:
   - Switch connection method to **Using persistent connection** (WebSocket mode) at the top of the page
   - Add event: `im.message.receive_v1`

   **Callback Configuration** tab:
   - Also switch to **Using persistent connection** (WebSocket mode)
   - Add callback: `card.action.trigger` (Card interaction callback) — required for confirm card buttons to work

5. Under **Permissions & Scopes**, add:

   | Permission | Purpose |
   |---|---|
   | `im:message` | Send messages |
   | `im:message.receive_v1` | Receive messages |
   | `im:message.p2p_msg:readonly` | Read DM messages |
   | `im:message.group_at_msg:readonly` | Read group @mentions |
   | `im:chat:readonly` | Read chat metadata |
   | `im:resource` | Download attachments |

6. **Publish** the app version so permissions take effect

### 2. Install the Plugin

Clone the repository:

```bash
git clone git@github.com:phxwang/feishuclaudecode.git
```

Register the local directory as a plugin marketplace, then install the plugin:

```bash
claude plugin marketplace add ./feishuclaudecode
claude plugin install feishu@feishu-local
```

### 3. Start Claude Code with the Feishu Channel

After installation, a `claude-feishu` shortcut is available (symlinked to `~/.local/bin` on first run). Use either:

```bash
claude-feishu
```

or the full command:

```bash
claude --dangerously-load-development-channels plugin:feishu@feishu-local
```

> **Note:** The `--dangerously-load-development-channels` flag is required because this is a local development channel plugin.

### 4. Configure Credentials

In your Claude Code terminal:

```
/feishu:auth cli_YOUR_APP_ID YOUR_APP_SECRET
```

Credentials are stored in `~/.claude/channels/feishu/.env` (mode 600).

### 5. Pair Your Account

1. Open Feishu and search for your bot by app name
2. Send any message to the bot
3. The bot replies with a pairing code
4. In Claude Code, run:

   ```
   /feishu:access pair <code>
   ```

5. The bot confirms: *"Paired! Say hi to Claude."*

You're ready — send messages to the bot and Claude will respond.

## Multi-Group Router

For multiple Feishu groups that each need an isolated Claude Code instance, use the **router**. It maintains a single Feishu WebSocket connection and routes messages to Claude instances via a Unix socket.

### Architecture

```
                             ┌─ server.ts (cwd=project-a) ─ Claude Code
Feishu WebSocket → router ───┤─ server.ts (cwd=project-b) ─ Claude Code
               (Unix socket) └─ server.ts (cwd=project-c) ─ Claude Code
                                  ▲ workers auto-connect on startup
```

### 1. Configure Group Workdirs

Add `workdir` to each group in `~/.claude/channels/feishu/access.json`:

```jsonc
{
  "groups": {
    "oc_groupA": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/path/to/project-a"
    },
    "oc_groupB": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/path/to/project-b"
    }
  },
  "defaultWorkdir": "/path/to/default-project"  // DMs route here
}
```

### 2. Start Claude Code Instances

In separate terminals, start Claude in each project directory:

```bash
cd /path/to/project-a
claude-feishu

cd /path/to/project-b
claude-feishu
```

The **first** Claude instance automatically spawns the router as a background process. Subsequent instances detect the router socket and connect as workers. The router matches incoming messages by `chat_id → workdir → connected worker`.

> **Manual router start** (optional): If you prefer to manage the router yourself, run `bun run router` in the plugin directory before starting any Claude instances.

### 4. Check Status

```bash
kill -USR1 $(pgrep -f 'bun router.ts')
cat ~/.claude/channels/feishu/router-debug.log | tail -10
```

## Access Management

All access commands are run in your Claude Code terminal via `/feishu:access`.

### Check Status

```
/feishu:access
```

### DM Policies

| Policy | Behavior |
|---|---|
| `pairing` (default) | Unknown users get a pairing code to approve |
| `allowlist` | Unknown users are silently dropped |
| `disabled` | All messages dropped |

```
/feishu:access policy allowlist
```

> **Tip:** Once all your users are paired, switch to `allowlist` to prevent unsolicited pairing requests.

### Manage Users

```bash
# Approve a pairing
/feishu:access pair <code>

# Deny a pairing
/feishu:access deny <code>

# Manually allow a user by open_id
/feishu:access allow ou_xxxxxxxxxxxxxxxxxxxx

# Remove a user
/feishu:access remove ou_xxxxxxxxxxxxxxxxxxxx
```

### Group Chats

Groups are off by default. The bot must be added to the group by a group admin first.

```bash
# Enable a group (responds on @mention only)
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx

# Respond to all messages (no @mention needed)
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx --no-mention

# Restrict to specific users within the group
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx --allow ou_id1,ou_id2

# Remove a group
/feishu:access group rm oc_xxxxxxxxxxxxxxxxxxxx
```

### Delivery Settings

```bash
# React to received messages with an emoji (default: Get)
/feishu:access set ackReaction Get

# Set max characters per message chunk
/feishu:access set textChunkLimit 4096

# Custom mention patterns for group chats
/feishu:access set mentionPatterns ["@claude","@assistant"]
```

## File Layout

```
~/.claude/channels/feishu/
├── .env              # App credentials (FEISHU_APP_ID, FEISHU_APP_SECRET)
├── access.json       # Access control state (auto-managed)
├── approved/         # Pairing approval signals (transient)
├── inbox/            # Downloaded attachments
├── debug.log         # Server debug log
├── router-debug.log  # Router debug log (when using router)
└── router/           # Router message inboxes (when using router)
    └── <chat_id>/    # Per-group message files
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FEISHU_APP_ID` | Yes | Feishu app ID (`cli_...`) |
| `FEISHU_APP_SECRET` | Yes | Feishu app secret |
| `FEISHU_ENCRYPT_KEY` | No | Event payload encryption key |
| `FEISHU_ACCESS_MODE` | No | Set to `static` to disable pairing |
| `FEISHU_STATE_DIR` | No | Override state directory path |
| `FEISHU_CHAT_ID` | No | Set by router — puts server.ts in worker mode |

## How It Works

### Smart Connection

The plugin detects whether it's running under a Feishu channel Claude instance by walking up the process tree and checking for `--dangerously-load-development-channels` with `feishu` in the ancestor's command line. Non-channel Claude instances (e.g., regular `claude` or `claude --channels plugin:discord@...`) skip the Feishu WebSocket connection entirely, keeping the MCP tools available without unnecessary remote connections.

### Orphan Protection

When the parent Claude process exits, the plugin detects the ppid change within 2 seconds and shuts down gracefully. This prevents orphaned `bun server.ts` processes from consuming 100% CPU — a workaround for Bun not reliably firing stdin `end`/`close` events on broken unix domain sockets.

## Testing

```bash
bun test
```

Tests cover access control (gate logic), text chunking, mention detection, permission reply parsing, confirm code generation, chat authorization, and router workdir resolution.

## Security

- Credentials are stored with `chmod 600` — only the owner can read them
- Pairing codes expire after 1 hour
- After 2 unapproved messages, senders are silently dropped until the code expires
- Access mutations can only be made from the Claude Code terminal — never from channel messages (prompt injection protection)
- Group chats require explicit opt-in per group

## License

MIT
