# Current Work

**Last updated:** 2026-04-23

## Fresh priority: Trippa not responding across channels (2026-04-23)

Current focus has shifted to a fresh investigation: **Trippa is not responding
right now on Telegram, Slack, and possibly other channels.**

Treat this as a runtime/delivery investigation first:
- verify inbound delivery path
- verify queue/wake behavior
- verify container/runtime health
- verify adapter-specific handling vs whole-agent failure

The Zip email quote work stays open, but it is no longer the primary focus.

## Zip email quote UX — in active QA, not shipped

The current focus is making Zip's email replies feel **actually Gmail-native**.
The first attempt at "full thread quotes" was the wrong shape: it created a
synthetic `Earlier in this conversation:` recap that looked fabricated and did
not trigger the Gmail hide/collapse behavior we wanted.

### What shipped to git today

- `483d249` — `fix: make email thread quotes look Gmail-native`
- `81cffa5` — `refactor: rely on parent-only email quotes`

### Current runtime state

- Zip is pointed at `feat/gmail-native-quote-chain`
- Verified through the logs endpoint that Zip was running commit `81cffa5`

### Current conclusion

This is **not done yet**.

What we know now:
- synthetic visible recap text is bad
- reconstructing our own thread transcript fights the native UX
- the likely right direction is to keep thread headers correct and quote only
  the real parent message, then let Gmail's heuristics do the collapsing
- more QA is required on Zip before calling the email threading work shipped

### Next step

Research raw Gmail reply behavior more carefully (body/MIME/quote shape), then
run another live QA loop on Zip.
