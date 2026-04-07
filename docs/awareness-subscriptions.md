# Awareness Subscriptions

Push the agent's awareness stream — the same thing the web workspace shows — to outbound channels like Telegram or Slack so you get real-time updates without watching the web UI.

## Where the config lives

`<workspace>/awareness/subscriptions.json`

Hot-reloaded: edit the file and the pump picks it up within ~200ms. No restart required.

## Minimum config

```json
[
  {
    "id": "tg-mirror",
    "adapter": "telegram",
    "destination": "<your-telegram-chat-id>"
  }
]
```

That's it. Default mode is `"mirror"`, which pushes every message line: user messages, assistant text, assistant thinking, tool calls, tool results, heartbeats, emails — same content the web awareness stream shows.

## Fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `id` | yes | — | Any unique string. Used for the rate-limit bucket and log lines. |
| `adapter` | yes | — | Adapter name: `telegram`, `slack`, `discord`, `email`. Must be one of the adapters this agent has running. |
| `destination` | yes | — | Channel/chat ID for that adapter. For Telegram, the numeric chat ID. For Slack, the channel ID like `C0123456`. |
| `mode` | no | `"mirror"` | `"mirror"` (everything) or `"responses"` (assistant text only). |
| `enabled` | no | `true` | Set `false` to keep the entry in the file but stop pushing. |

## Modes

- **`mirror`** — every message line. Use this if you want a true second screen.
- **`responses`** — only what the agent says out loud (assistant text). Use this if mirror is too noisy on your phone and you only care about final responses.

## How to find your Telegram chat ID

Easiest: send the agent any message on Telegram, then look at the awareness stream (web UI or `context.jsonl`). The channel will appear as `telegram:123456` — the number is the chat ID.

Or use [@userinfobot](https://t.me/userinfobot) on Telegram, which replies with your user ID for DMs.

For group chats, the ID is negative (e.g. `-1001234567890`).

## Loop guard

The pump automatically drops messages whose source channel matches the subscription's destination. So if you mirror to Telegram chat `123` and you also chat with the agent in that same Telegram chat `123`, your replies don't get mirrored back — only messages from *other* channels do.

## Rate limiting

Each subscription gets a per-subscription token bucket: burst of 3 messages, refilling 1 token every 5 seconds. Overflow is coalesced into a single `+N more` message after the cooldown so a busy agent doesn't flood your phone.

## Multiple subscriptions

The file is an array — list as many as you want. They're independent (independent buckets, independent loop guards).

```json
[
  {
    "id": "tg-everything",
    "adapter": "telegram",
    "destination": "123456"
  },
  {
    "id": "slack-quiet",
    "adapter": "slack",
    "destination": "C0987654",
    "mode": "responses"
  }
]
```

## Disabling without deleting

Set `"enabled": false` on the entry. Useful for muting a subscription temporarily without losing the config.
