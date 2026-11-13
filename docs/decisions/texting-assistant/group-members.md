# A WhatsApp group's people are kept, and trusted before sending until they change (2026-11-12)

Decided by Dev2, 2026-11-12, after the Crystal Care Agency WhatsApp group lost a
finished answer on 2026-11-11: Tex wrote it, then both reads of the member list
before sending failed, and the chat was told "Something broke on my side".

## The rule

An answer in a group goes only to the people it was written for. Someone who
joined while Tex worked never sees it. That rule is unchanged; what changed is
where the list comes from at send time.

- Every group turn reads the app's member list as it starts (`groupInbox.ts`).
  For an app that reports group changes by webhook (WhatsApp, through Whapi's
  `groups` events), that list is kept in the group's own object with when the
  read started (`groupMembers.ts`, key `gmembers`).
- A Whapi `groups` delivery marks every group it names changed. Its shape is
  not relied on: any string in it that is a group id counts
  (`whapiGroupChanges`), so a field Whapi moves never hides a join.
- Before an answer or a progress line goes out, a kept list read under
  `KEPT_FRESH_MS` (10 minutes) ago with no change since is the list. A stale or
  changed one is read from the app again, twice before giving up, and an unread
  list still holds the answer.
- A change reported while a read was out stays marked: that read does not
  cover it.
- iMessage (Sendblue) reports no such events, so it reads the app before every
  send, as before.
- A failed Whapi read logs why: a status, a timeout, a body that is not one, or
  a group with no participants (`whapi_read_failed`).

This is the usual way chat bots do it (Slack's `member_joined_channel`,
Discord's member events, Telegram's `chat_member` updates): a cache fed by
events and re-read now and then, not a full read before every message.

Background jobs still read the app themselves (`jobRun.ts`): they run in their
own object, which does not hold the group's kept list.

## Who heard a WhatsApp line (2026-11-12)

A group's untagged lines are bound, kept and handed to the next tag by a hash
of the people each was said in front of (`groupChat.ts`). Sendblue's webhook
lists everyone; Whapi's names only the sender, so the hash was the sender's
alone: the chat was bound to whoever last tagged Tex, and every other member's
untagged line was dropped. On 2026-11-12 a member's message in a WhatsApp group
went unseen this way, and Tex told the next asker it could not see it.

- A WhatsApp message now carries the kept list as its people
  (`withKeptMembers`), as an iMessage carries its own. It keeps its sender
  alone, and so is dropped as before, when no list is kept yet, the app said
  the people changed, or the list does not name the sender (it is behind).
- A WhatsApp turn binds the chat and reads its lines by the list it just read
  from the app, with the asker (`inRoom`). A join Whapi never reported changes
  that hash, so lines kept under the old list never reach a turn in front of
  the newcomer.


- Trusting the kept list with no freshness bound: a missed or late webhook
  would let a newcomer see answers drawn from the workspace for as long as
  nobody else changed. Ten minutes bounds that to the turn itself, since every
  turn reads the app as it starts.
- Reading the app before every send again: one Whapi hiccup throws a finished
  answer away, as it did on 2026-11-11.
- Applying a `groups` event's add or remove to the list instead of marking it
  changed: it would rest on a payload shape nobody has sampled yet
  ([provider-events](./provider-events.md)). Marking it changed costs one read.

Tests: `apps/agent/src/groupMembers.test.ts` (the Crystal Care regression, a
reported change re-reads and holds for a newcomer, staleness, a change during a
read), `groupProgress.test.ts` and `groupDecide.test.ts` (a newcomer on
WhatsApp arrives by event), `whapiWorker.test.ts` (each `groups` event marks
its group, a delivery naming none marks nothing), `groupWhapiMembers.test.ts`
(another member's untagged line reaches the next tag; dropped with no list, a
changed list or a newcomer; never handed on past a missed join).
