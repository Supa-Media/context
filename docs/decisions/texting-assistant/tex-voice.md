# How Tex sounds in each chat

Decided by Dev2, 2026-10-28.

Tex sounded the same in every chat: one texting style, or the production
setup's prompt in its place, plus whatever settings someone set by hand
([tex-settings](./tex-settings.md)). Nothing told it to sound like the people
it texts with or to answer in their language.

- **Mirror the chat.** Every texted turn, 1:1 and group, is told to match how
  the people in the chat write (casual or formal, emoji, slang,
  capitalization), within the chat's own settings, never copying an insult and
  never letting it change what Tex may do.
- **Their language.** Every texted turn is told to answer in the language of
  the person it answers (in a group, the tagger).
- Both lines are said after the production prompt, as the pushback line is
  ([pushback](./pushback.md)): they are rules of the product, not one setup's
  voice.
- **Settings beat group defaults.** A length someone set says it replaces any
  earlier length rule, so a group set to Detailed is not held to "a line or
  two". With no length set, the line or two stands.
- **A group's voice note.** `tex/groups/voice-<id>.md`, beside the chat's
  memory note and named by the same people hash, so a new set of people starts
  a new one. Tex keeps at most six short bullets there about style only and
  updates them with write_note when it learns something lasting, as it keeps a
  person's about-me. Every group turn reads it, bounded to six lines and 600
  characters. It is a plain note, so a person's edit wins.

The voice note is its own note rather than a section of the memory note,
because the memory note is rewritten whole after every turn and a section
there would be overwritten or would conflict with Tex's own edit.

Tests: `apps/mcp/test/agentChatVoice.test.mjs`.
