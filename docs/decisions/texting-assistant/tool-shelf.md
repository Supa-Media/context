# The tool shelf and a shorter memory

Part of [the texting assistant](../texting-assistant.md).

## A setup hands Tex a few tools and names the rest (2026-10-14)

Decided by the owner, 2026-10-14, after finding Tex "very stupid": "we only
give it the absolute necessity tools ... it should know the names of the tools
... and then it uses tool search to get the actual schema." Every texted turn
was handed about fifty tools, some 18,000 tokens of schema, on every round,
and a small model buried in descriptions picks slowly and badly.

A setup may name its core tools (`core_tools: [search_notes, read_note, …]` in
`ai/production/<job>.md`). A turn is then offered those, each cut to the first
paragraph of its description, plus `find_tools`; every other tool it holds is
listed in the system prompt by name and first sentence, and `find_tools`
(by names, or by a few words) puts the full definition in the tool list from
the next round on (`apps/mcp/src/agent/toolShelf.js`). With four core tools the
tools and the list together are about 3,600 tokens. A setup with no
`core_tools` is offered everything, as before.

The shelf changes what the model is told about, never what it may reach: every
shelved tool is one the turn already holds, so a model that calls one by name
without loading it has it loaded and run, and a name the turn does not hold is
still refused. `write_note`'s routine help sits in its first paragraph so a core
`write_note` keeps it. This is ours rather than a provider's tool-search
feature because a turn can fall back to a non-Claude model mid-turn.

**What a simplification would cost:** offering every tool again puts the
18,000 tokens back on every round; hiding the shelved names from the prompt
gets "I can't do that" for things Tex can do. Tests:
`apps/mcp/test/agentToolShelf.test.mjs`.

## The conversation is kept long and shown short (2026-10-14)

Same conversation: "Every text is a brand new turn. I don't necessarily think
that that is bad ... if it does need to, we should have a tool that just shows
it what was said in the past because we should still keep running history."
The conversation file keeps the last 40 texts (40,000 characters); a turn is
shown the setup's `history:` count of them (12 when unset, 0 allowed), and
`earlier_texts` reads the whole file in words when a text points back further.
Reading it marks the turn as having read from outside when anything in it was
written after such a read, as the shown part already does.

**What a simplification would cost:** showing the whole file again is the
bloat the owner asked to remove; dropping the file loses "the second one".
Tests: "a turn is shown the newest texts its setup asks for, and
earlier_texts reads them all", `apps/mcp/test/agentConversation.test.mjs`.

## Tex keeps what it knows about the person in `tex/about-me.md` (2026-10-14)

Same conversation: Tex "knows nothing about me when the text arrives", and
its memory belongs in a `tex/` folder, "memory about me that it's always
updating", not in a framework's opaque store. A texted turn reads
`tex/about-me.md` from the person's own workspace through the session's
dispatcher (so `privacy.md` and the grant decide, as for any read), puts up
all of it in the system prompt, and, when it can write, is
told to add lasting facts there with `write_note`, reading first. A missing or
unreadable note is an empty one, never a failed turn
(`apps/mcp/src/agent/aboutMe.js`). It is an ordinary note: the person reads,
corrects or deletes it like any other, every change is in its history, and it
leaves with an export.

The note has a hard size: 500 lines and 40,000 characters (the owner,
2026-10-14: "it doesn't need to be more than 500 lines"). `write_note` refuses
any write past it, whoever the writer, and `remember` goes through the same
check, so the prompt always carries the whole note and Tex is told to merge
and drop what's stale as it grows.

**What a simplification would cost:** keeping the profile anywhere but a note
makes it the opaque memory the owner ruled out. Tests:
`apps/mcp/test/agentAboutMe.test.mjs`, and "Tex's memory note holds at most 500
lines, from write_note and remember alike" (`apps/mcp/test/remember.test.mjs`).
