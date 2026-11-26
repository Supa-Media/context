# Chat style: Tex writes the way each chat texts

Decided by the owner, 2026-11-25 (Dev2: "model ... being able to match the flow, energy, and style of the people in the
groupchat or 1:1"; picked "Training + style facts" over Training alone and over a separate voice-rewrite step).

Tex mirrors how the people in a chat text: lowercase when they write lowercase, capitals and full stops when they use
them, about as long as their texts, their slang and emoji only after they have used them, and in a group the room,
leaning toward the person it answers. It tells banter from an ask by reading the chat.

Two levers, no third model call:

- **Facts, as data.** The `chatStyle` node (`packages/tex/gateway/agent/chatStyle.js`) counts the people's own recent
  texts in the ledger entries the turn's history read already holds, with no read of its own, so a texted turn's calls stay in budget (never Tex's texts: mirroring itself would freeze its first style): how many start in lowercase,
  end on a full stop or hold a "!", the median words, the emoji used, for the room and, in a group, each person. The
  front door reads them in its per-text facts as a `<chat_style>` block of JSON. No sentence of how to use them lives
  in code (`no-scripted-wording.md`).
- **Judgment, by example.** The voice modules (`texPrompt/how-you-talk.md`, `sound-like-a-person.md`) and the Training
  conversations show replies in the chat's own register, banter answered as banter.

A separate rewrite pass (Poke's split of a conversational layer from execution) was not chosen: it adds a model call to
every text, and the front door already writes every text Tex sends.

What a "simplification" would cost: counting Tex's own texts, or dropping the facts for prompt words alone, puts back
the one house style (measured 2026-11-25: module words alone left a lowercase group answered in sentence case).
`apps/mcp/test/chatStyle.test.mjs` fails if Tex's texts are counted, if old texts are, or if the node's logged output
carries the chat's words.
