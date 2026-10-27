# Tex event log and model-decided turns: contracts

Approved by Dev2, 2026-10-26. One PR, straight to production, no switch; the
fallback is reverting the PR. Today's history (`apps/mcp/src/agent/events.js`,
`conversation.js`, `tex/groups/chat-<id>.md`) keeps being written beside the
new log, so a revert loses nothing.

Dev2 reverses five recorded decisions (records rewritten in this PR, credited
"Dev2, 2026-10-26"): groups answer only when addressed with no model
(groups.md); two people's texts are two questions (groupInbox.ts); replies,
tapbacks and photos are never steered or folded (runtime.md); code alone
decides when an ask stops listening (thumbs-up.md, now: the model may end it
sooner, never later); corrections judged on the person's words, never the
model's (honest-answers.md 2026-10-26, now: the model judges).

Kept as code, never the model: only the asker's yes, given after Tex last
showed the held call, releases it; guests never approve; `canSee` on every
path; a newcomer never sees events from before they joined; history is words,
never a tool's result; people's edits to the group memory note win.

Works for every line the Worker serves: Sendblue (iMessage/SMS) and Whapi
(WhatsApp), 1:1 and groups (`apps/agent/src/line.ts`, `groupLine.ts`).

## 1. Event

One per thing that happens in a chat. Append-only, never edited.

```ts
type Event = {
  id: string;            // `${at padded to 13}-${seq padded to 6}`; sorts by time
  at: number;            // ms; received (inbound) or sent (outbound)
  chat: string;          // the chat key the Worker already uses (1:1 chat id or group id)
  from: { kind: "person" | "tex" | "system"; who?: string /* sha256 of the handle */; name?: string /* display handle, groups */ };
  kind: "text" | "picture" | "file" | "link" | "reaction" | "ask" | "ask_settled" | "delivery";
  text?: string;         // <= 3000 chars; the words, never a tool result
  replyTo?: string;      // event id, an inline reply
  delivered?: boolean;   // outbound parts only
  reason?: "upload_failed" | "send_refused" | "held_newcomer" | "failed" | "timed_out" | "too_long";
  turn?: string;         // the turn id that produced it (outbound) or answered it
  covers?: string[];     // on Tex's answer: the inbound event ids it answered
  people?: string;       // groups: sha256 of the sorted participants when it happened (groupChat.ts peopleOf)
  told?: string;         // a fixed Worker text by name (replaces apps/agent/src/told.ts names)
};
```

Storage: `.context/agent/log/<sha256(chat)>/<id>.json` in the customer's
bucket — the person's own for 1:1, the bound shared workspace's for a group.
Read newest-first, bounded (400 events or 120,000 chars). The Worker's Durable
Object keeps only a buffer of events not yet written (bounded, as today).

## 2. Gateway: `POST /agent/events`

Auth: the per-person access token the Worker already uses for `/agent`
(`clients.ts`), client `context_texts` / `context_texts_group`, write scope.
Body `{ conversation: "texts" | { group }, events: Event[] }`, at most 50 per
call. Validation is a trust boundary: closed sets for `kind`/`reason`/`from.kind`,
length caps, `at` within ±1 day of now, ids well-formed. Returns
`{ written: string[] }`. Idempotent by `id`.

## 3. Convex: `POST /agent-texts/decide`

Auth: `AGENT_WORKER_SECRET` bearer, as `/agent-texts/session`. Body:

```ts
{ workspaceId?: string; chat: string; style: "quiet" | "attentive" | "followAlong" | "helpful" | "direct";
  transcript: string;    // rendered (section 5), newest last, <= 24,000 chars
  candidates: string[];  // the newest event ids it may cover, <= 32
  running: boolean;      // a turn is in flight
  waitingAsks: string[]; // ask event ids still waiting for a yes, <= 8
  newest: string }       // the event id that triggered this decision
```

Runs Clef through `withJev(ctx, { feature: "textDecide", workspaceId }, …)`
(registered in `lib/jev/features.ts`, `plan: "everyone"`, 2,000 calls per
workspace per day). Typed questions only. Returns:

```ts
{ ok: true; act: "silent" | "react" | "answer"; covers: string[];
  midTurn?: "fold" | "queue" | "restart"; stale: string[]; movedOn: boolean; confidence: number }
| { ok: false; reason: "capped" | "off" | "unavailable" }
```

`ok:false` means the Worker falls back: groups answer only when addressed
(today's `addressesTex`), 1:1 always answers.

## 4. Worker

- Every inbound message → an `Event`, buffered, then `POST /agent/events`.
- Which inbound events reach decide is the group's style (`textGroups.engagement`,
  default `followAlong`): `quiet` only addressed messages; `attentive` adds the
  asker's texts while their ask waits; `followAlong` adds untagged texts after
  Tex speaks until decide returns `movedOn: true` or 20 texts; `helpful` every
  text. 1:1 chats use `style: "direct"`: every text is decided, and `silent`
  is only allowed for a pure acknowledgement (a tapback, "ok", "thanks").
- `answer` → `/agent` with `covers`; `react` → a tapback; `silent` → nothing.
- A text while a turn runs → decide with `running: true`: `fold` → today's
  steer injection (any kind of message now); `queue` → held, answered next;
  `restart` → `/agent/cancel` for the running turn, then a new turn covering
  both. The gateway's cancel withdraws that turn's held asks.
- `stale` ask ids → those asks are disarmed (gateway `disarmRecords`); never
  extended.
- `/agent/cancel` answers `{ cancelled: false }`, marking nothing, when no
  turn of this person runs under that id or the running one already made a
  call that changed something or went out; the Worker then treats the text as
  `queue`. The turn's own `/agent` answer is `{ cancelled: true }` whenever it
  saw the mark, including a cancel that landed after its last round.
- Every outbound part → an `Event` with `delivered`/`reason`.
- First addressed message in a group whose style was never chosen: Tex asks
  before answering, with the approved wording; any member's "1"–"4" or a name
  sets it, Tex confirms with who set it and "To change it later, text
  \"Tex, settings\"", then answers the original message. "Tex, settings" shows
  the choice again.

## 5. Rendering (what the model and decide see)

```
--- Monday, Oct 26 ---
[12:16 PM] Ada: Tex check this link out
[12:16 PM] Ada: https://reasonmachines.com/…
[12:17 PM] You: I read the Reason page…
           (not delivered: the picture didn't reach them)
[12:19 PM] Ada: are you thinking straight?   (not answered)
```

Local time from the person's time zone. "You" is Tex. An inbound event no
delivered Tex answer `covers` is "(not answered)". A group newcomer's
rendering starts at the first event whose `people` includes them.
