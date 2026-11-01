# Every reaction in a chat is input (2026-11-01)

Decided by Dev2, 2026-11-01, after two bug reports from the same group
(705d8954 and 70c05f): Dev2's 👍 on Tex's settings question ("👍 or 👎?") was
dropped by the Worker as `sendblue_webhook ignored reason=group_reaction`, so
the settings Tex had proposed were set only after a later text. A group read a
tapback only when it was the asker's like or dislike on a held ask; WhatsApp
groups read only a like or a love. Everything else was thrown away before
anything could see it.

## What changed

- **Every reaction is an event.** Added or taken back, in a group or one to
  one, on Sendblue or WhatsApp, each one goes into the chat's event log as the
  line a model reads: who reacted (the event's sender), the emoji, whether
  that emoji says yes or no, and which message it was on, with whether that
  message is Tex's. For example `👍 (yes) on Tex's message "…"`,
  `❤️ (yes) on the message "…"` or `took back 👍 on …`
  (`apps/agent/src/reactions.ts` `reactionLine`). 👍, ❤️ and ‼️ read as yes,
  👎 as no, and any other emoji as itself.
- **Which message is Tex's.** WhatsApp names the message, and the Worker
  reads it back (`readOwnMessage`). Sendblue only quotes the words, so they
  are compared with the texts Tex sent in that chat's log, a turn's or a
  fixed line (`thumbs.ts` `onTexText`).
- **A reaction on Tex's own question is that person's answer.** In a group it
  is answered the way a message addressed to Tex is (`groupInbox.ts`
  `acceptReaction`, `answersTex`): through the conversation state machine, and
  never left silent, which is what the one-to-one chat already did since
  #2469. Mid-turn it is decided like any addressed message.
- **A reaction on anybody else's message is context.** It is a line of the
  chat, read by decide only as the group's style allows, as an untagged message
  is. It never forces a reply.
- **WhatsApp groups read every emoji** (`whapiInbound.ts` `tapbackOf`), not
  only a like or a love. Sendblue drops only a tapback it cannot read at all.
- **Logged as codes only:** `reaction_answer`, `reaction_context`,
  `reaction_removed`, and `reaction_ask` for a held yes or no, in place of the
  dropped `group_reaction`.

## The rails are unchanged

- Only the asker's 👍, ❤️ or 👎 on the ask itself, while that ask is open, is
  held as their yes or no (`holdThumb`), and the gateway still checks its
  words against what is armed now (`thumbsUpIsYes`). The asker is the person
  Tex last asked, matched in code (`isAsker`).
- A reaction that is not held reaches the gateway as its line alone, never as
  a tapback with quoted words (`enqueue` drops `reaction`), so nothing but a
  held one can be taken for a yes there.
- Somebody else's reaction on the asker's held ask is context, never an answer
  and never a yes. A guest's reaction is held only if the guest is the asker,
  and the gateway takes no yes from a guest's turn (`guestTagger`), so a
  guest's reaction never approves anything.
- Taking a reaction back drops a held yes only when it was the asker's.

## What was weighed

- **Put every reaction on Tex's text to decide as soft.** Rejected: decide may
  leave a soft line silent, which is the bug that was reported. An answer Tex
  invited has to get its turn, as one to one.
- **Send the tapback and its quoted words to the gateway for every answer.**
  Rejected: the gateway would then match somebody else's 👍 on the asker's
  ask against what is armed, and could release it.
- **Treat any reaction from the asker as their answer, wherever it is.**
  Rejected: the ask must be what the reaction is on. The asker's 👍 on
  somebody's joke is context like anyone's.

## Known limits

- Sendblue words matching is by prefix (`sameWords`), so a reaction quoting
  a short text that happens to begin a text Tex sent reads as on Tex's.
- An idle answer to Tex's question skips decide, as any addressed message
  in a group does (`addressedTurn`); decide still reads it in the log.
