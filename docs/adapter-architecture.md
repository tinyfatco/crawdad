# Platform Adapter Architecture

Mom's agent is platform-agnostic. It communicates through a `MomContext` interface that abstracts away all platform-specific behavior. Each platform (Slack, Telegram, etc.) implements a `PlatformAdapter` that translates between the platform's API and this context.

## Core Interfaces

### PlatformAdapter

The contract each platform implements. Handles connection lifecycle, message operations, metadata, and context creation.

```
PlatformAdapter
├── name, maxMessageLength, formatInstructions  — platform identity
├── start(), stop()                             — connection lifecycle
├── postMessage(), updateMessage(), deleteMessage(), postInThread()  — messaging
├── uploadFile()                                — file sharing
├── logToFile(), logBotResponse()               — persistence
├── getUser(), getChannel(), getAllUsers(), getAllChannels()  — metadata
├── createContext()                             — UX mapping (see below)
└── enqueueEvent()                             — scheduled event queue
```

### MomContext

What the agent talks through during a run. Created fresh per message by the adapter's `createContext()`. The agent calls these methods without knowing what platform it's on.

```
MomContext
├── message        — incoming message data (text, user, channel, attachments)
├── respond()      — append text to the main response
├── replaceMessage() — overwrite the main response entirely
├── respondInThread() — post detail (tool results, etc.) as supplementary
├── setTyping()    — show typing/thinking indicator
├── setWorking()   — show/hide working indicator (" ...")
├── uploadFile()   — attach a file to the conversation
└── deleteMessage() — delete the response (used for [SILENT] events)
```

### MomHandler

The handler that adapters call into when messages arrive. Implemented by `main.ts`.

```
MomHandler
├── isRunning(channelId)  — sync check if channel is busy
├── handleEvent(event)    — process a message (async)
└── handleStop(channelId) — abort current run
```

## How It Fits Together

```
User message
    │
    ▼
PlatformAdapter (Slack/Telegram/...)
    │  translates platform event → MomEvent
    │  calls handler.handleEvent()
    ▼
main.ts handler
    │  gets/creates channel state
    │  calls adapter.createContext() → MomContext
    │  calls runner.run(ctx)
    ▼
agent.ts (AgentRunner)
    │  builds system prompt with adapter.formatInstructions
    │  runs AgentSession
    │  on tool results: ctx.respondInThread(details)
    │  on final response: ctx.respond(text)
    ▼
MomContext callbacks
    │  adapter-specific implementation
    │  Slack: threads, mrkdwn, WebClient
    │  Telegram: replies, MarkdownV2, Bot API
    ▼
Platform API
```

## createContext() — The UX Layer

`createContext()` is where each adapter defines its user experience. The same agent event (`respondInThread` for tool details, `respond` for the final answer) can map to completely different platform behaviors:

**Slack adapter:**
- `respond()` → Edit a single accumulating message in the channel
- `respondInThread()` → Post as a thread reply (collapsible, detail-level)
- `setWorking()` → Append/remove " ..." suffix via message edit

**Telegram adapter:**
- `respond()` → Edit a single accumulating message via `editMessageText`
- `respondInThread()` → Reply to the main message (visible in chat, not collapsible)
- `setTyping()` → `sendChatAction("typing")`

This is the natural extension point. A Discord adapter might use embeds for tool details. A CLI adapter might print to stderr. A web adapter might use a split pane. The agent code is identical in all cases.

## formatInstructions

Each adapter provides `formatInstructions` — a string injected into the agent's system prompt telling it how to format text for that platform:

- **Slack:** mrkdwn syntax (`*bold*`, `<url|text>`, no `**double asterisks**`)
- **Telegram:** MarkdownV2 syntax (`*bold*`, `[text](url)`, escape special chars)

The agent adapts its output formatting without any code changes.

## Adding a New Adapter

1. Create `adapters/<platform>.ts` implementing `PlatformAdapter`
2. Implement `createContext()` with platform-appropriate UX mapping
3. Set `formatInstructions` for the platform's text formatting
4. Add the adapter to `createAdapter()` in `main.ts`
5. Add a new env var for the platform's auth token

That's it. The agent, handler, events system, session management, and tools all work unchanged.

## File Structure

```
src/
├── adapters/
│   ├── types.ts      — PlatformAdapter, MomContext, MomEvent, MomHandler
│   ├── slack.ts      — SlackAdapter (Socket Mode + WebClient)
│   └── telegram.ts   — TelegramAdapter (polling + Bot API)
├── agent.ts          — AgentRunner, system prompt, tool handling
├── main.ts           — CLI, adapter factory, handler, channel state
├── events.ts         — Scheduled event watcher
├── context.ts        — Session sync, settings manager
├── store.ts          — Channel data persistence
├── sandbox.ts        — Docker/host execution
└── tools/            — Tool implementations (bash, read, write, edit, attach)
```
