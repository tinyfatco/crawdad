# Presence & Ticks

**Status:** Shipped April 2026.
**Files:** `src/presence.ts`, `src/adapters/tick.ts`, `src/tools/tune-in.ts`, `src/tools/tune-out.ts`, `src/templates/TICK.md`.

## The problem

Heartbeat fires sparsely (hourly-ish, cron-scheduled via `events/heartbeat.json`). It runs a review-and-act checklist prompt — "did anything crash, should you reach out, what patterns do you notice." That prompt is too heavy for something that fires every few minutes, and setting heartbeat cron to `*/5` just creates an anxiety loop of the agent auditing itself every five minutes.

What we actually want is two different spontaneity regimes:

- **Sparse continuity** — the agent wakes occasionally, remembers where it was, catches dropped threads. This is heartbeat, and it should stay roughly as-is.
- **Live presence** — the agent is "around," getting a cheap steering nudge every 1-10 minutes, reaching out via `send_message_to_channel` when something surfaces, yielding silently when nothing does.

These have different prompts, different cadences, different purposes. They should not be the same mechanism with different cron schedules.

## The three-layer model

| Layer | Cadence | When it fires | Prompt character | Purpose |
|---|---|---|---|---|
| **Heartbeat** | Sparse (cron-scheduled, default hourly) | Always — both presence states | Review, audit, follow up on incomplete work | Continuity across sessions, catch dropped threads |
| **Tick** | Frequent (1-10 min, configurable) | Only while `presence=here` | Ambient, present-tense, "you're around" | Live presence, continuous availability |
| **Inbound** | On-demand | Always | Adapter-specific | Reactivity |

**Heartbeat is NOT gated by presence.** It fires in both states. It's the safety net that ensures a tuned-out agent still occasionally wakes to remember the arc.

**Ticks are only while tuned in.** The tick adapter's internal timer starts when the agent calls `tune_in` and stops when it calls `tune_out`. No presence → no ticks → no cost.

## `tune_in` / `tune_out`

Two tools, verb-y, give the agent a sense of *doing* something rather than flipping a flag.

### `tune_in(reason, interval?, disposition?)`

- `reason` (required, string) — why tuning in, for the awareness line and for future self-reflection
- `interval` (optional, enum: `"1m" | "2m" | "2.5m" | "5m" | "10m"`, default `"5m"`) — how often ticks fire
- `disposition` (optional, enum: `"quiet" | "narrating"`, default `"quiet"`) — how talkative to be during ticks

### `tune_out(reason)`

- `reason` (required, string) — why tuning out, for the awareness line

### Disposition

- **`quiet`** (default) — ambient presence. Most ticks end with `yield_no_action`. The agent is around but not chatty. It may do silent work in the sandbox (reading, writing files) without messaging. Messages only when something actually surfaces.
- **`narrating`** — the owner has explicitly asked for running updates ("be with it and work on this, update me as you go"). The agent messages more freely during ticks. Still can yield when there's nothing new, but the bar for messaging is lower.

Same adapter, same cadence, different prompt branch.

## Storage: `PRESENCE.json`

Single source of truth, file-backed in the workspace (survives container restarts via R2 FUSE mount, visible to the agent via read/write tools).

```json
{
  "state": "here",
  "since": "2026-04-07T14:22:00Z",
  "reason": "watching for Brandon's reply",
  "interval": "5m",
  "disposition": "quiet",
  "consecutive_yields": 3
}
```

- `state`: `"here" | "away"`. Default `"away"` if file missing (preserves current behavior for existing agents).
- `since`: ISO timestamp of last state transition.
- `reason`: last reason string from tune_in or tune_out.
- `interval`: current tick interval (only meaningful when `state === "here"`).
- `disposition`: current tick disposition (only meaningful when `state === "here"`).
- `consecutive_yields`: number of consecutive ticks that ended in `yield_no_action`. Used for auto-tune-out.

## Auto-tune-out

Safety valve: if the agent tunes in and then forgets to tune out, it racks up tick cost for nothing.

**Rule:** 20 consecutive ticks ending in `yield_no_action` → auto-tune-out. At 5-minute interval that's ~100 min of quiet presence before the system intervenes. At 1-minute interval it's 20 minutes. The count resets on any tick that does NOT yield (i.e. any tick where the agent actually messaged or did meaningful work).

An awareness line is written on auto-tune-out: `[PRESENCE] tuned out: auto (20 quiet ticks)`.

## `TICK.md`

Lives in the workspace root like `HEARTBEAT.md`. Agent-editable, contains the tick prompt. A default template ships in `src/templates/TICK.md` and gets copied to the workspace on first boot if it doesn't exist.

The prompt emphasizes:
- Present-tense, you're here, time is passing, something small just happened (nothing)
- `send_message_to_channel` as the way to reach out when something's worth sharing
- `yield_no_action` as the natural baseline when nothing is
- Different voice for `quiet` vs `narrating` disposition

## Skip-if-running

If a tick fires while the previous tick's run is still in-flight, **skip it**. Don't queue. Ticks are ambient; missing one is fine; a backlog is bad. Log the skip.

## Open extensions (not in v1)

- Heartbeat prompt rewrite to include continuity hooks ("when did you last tune in? what was going on? did you finish?") — separate workshop.
- Dashboard surface: fat-platform reading `PRESENCE.json` to show "Zip is here" / "Zip is away."
- Container sleep alignment: when tuned out, allow container to sleep more aggressively.
- Agent-configurable auto-tune-out threshold.
