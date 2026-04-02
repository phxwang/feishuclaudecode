# Feishu — Access & Delivery

Feishu (Lark) bots communicate through the Open Platform's event subscription
system. This plugin uses **WebSocket persistent connection** mode — no public
HTTPS endpoint required.

## Prerequisites

1. Create a **Custom App** at [open.feishu.cn](https://open.feishu.cn)
2. Under **Event Subscriptions**: enable **Using persistent connection** and add event `im.message.receive_v1`
3. Under **Permissions & Scopes**: add the permissions listed below
4. Publish the app version

## At a glance

| | |
|---|---|
| Default policy | `pairing` |
| User identifier | open_id (e.g. `ou_xxxx...`) |
| Group key | Feishu group chat_id (`oc_xxxx...`) |
| Config file | `~/.claude/channels/feishu/access.json` |
| Credentials file | `~/.claude/channels/feishu/.env` |

## Required app permissions

| Permission | Purpose |
|---|---|
| `im:message` | Send messages |
| `im:message.receive_v1` | Subscribe to incoming messages |
| `im:message.p2p_msg:readonly` | Read P2P (DM) messages |
| `im:message.group_at_msg:readonly` | Read group messages with @mention |
| `im:chat:readonly` | Read chat metadata |
| `im:resource` | Download file/image attachments |

## DM policies

`dmPolicy` controls how P2P messages from non-allowlisted users are handled.

| Policy | Behavior |
|---|---|
| `pairing` (default) | Reply with a pairing code; drop the message. Approve with `/feishu:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Use once all needed users are allowlisted. |
| `disabled` | Drop everything, including allowlisted users and group chats. |

```
/feishu:access policy allowlist
```

## User IDs (open_id)

Feishu identifies users by **open_id**: app-specific strings like `ou_...`.
The allowlist stores open_ids. Pairing captures the ID automatically.

To add someone without pairing: get their open_id from the Feishu admin console
or ask them to DM the bot and initiate pairing.

```
/feishu:access allow ou_xxxxxxxxxxxxxxxxxxxx
/feishu:access remove ou_xxxxxxxxxxxxxxxxxxxx
```

## Group chats

Group chats are **off by default**. Opt in per-group using the group's chat_id
(`oc_...`). By default, the bot only responds when @mentioned in a group.

```
# Opt in a group (respond only on @mention)
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx

# Respond to all messages in the group (no mention required)
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx --no-mention

# Restrict to specific users within the group
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx --allow ou_id1,ou_id2

# Remove a group
/feishu:access group rm oc_xxxxxxxxxxxxxxxxxxxx
```

The bot must be added to the group by a group admin before it can receive messages.

## Pairing flow

1. User opens a DM with the bot in Feishu (search by app name)
2. User sends any message
3. Bot replies: *"Pairing required — run in Claude Code: `/feishu:access pair <code>`"*
4. User runs that command in their Claude Code terminal
5. Bot confirms: *"Paired! Say hi to Claude."*

The code is valid for 1 hour. After 2 messages without approval, the sender is silently dropped until the code expires.

## Delivery config

Customize via `/feishu:access set`:

| Key | Default | Description |
|---|---|---|
| `ackReaction` | `""` (off) | Feishu emoji_type to react with on receipt (e.g. `THUMBSUP`) |
| `textChunkLimit` | `4096` | Max chars per message before splitting |
| `mentionPatterns` | `[]` | Regex patterns to count as a mention in group chats |

```
/feishu:access set ackReaction THUMBSUP
/feishu:access set mentionPatterns ["@claude","@assistant"]
```

## Setup commands

```
# Configure credentials
/feishu:auth cli_xxxx your_app_secret

# Check status
/feishu:auth

# Pair a new user
/feishu:access pair <code>

# Check access status
/feishu:access
```
