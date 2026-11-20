# Texting assistant — the prompt cache rules

### A step's reads run by how often they change, and its slow modules can freeze until the next summary

Decided by the owner on 2026-11-20, from the cache rules slide: until the next
summary, the tools, system prompt and first message stay byte-identical; a
deploy's change reaches running chats as a note; everything is built in a fixed,
sorted order; tools are never added or removed for one turn; each section is
hashed separately; the cache is warmed when the chat opens or the person starts
typing. The tool list half is [tool-rules](./tool-rules.md).

**Run order.** Every context module has a kind (`packages/tex/src/texModuleChange.cjs`):
`fixed` (the same until a deploy), `summary` (changes rarely), `grows` (the chat,
word for word) or `text` (changes every text). A step runs its reads stably
sorted by kind, whatever order the Lab lists them in, so something that changes
less can never sit below something that changes more and break the cache for
it. The Lab says so loudly ("you put it 2nd, it runs 1st") and offers "Put them
in run order"; `tex_dev config` warns the same. Owner, 2026-11-20: "a processor,
not a CI check".

**The freeze.** The audit of 2026-11-20 found modules above the history that
change on 2–10% of texts (a group's playbook and who's who 10%, About me 6%,
learned skills, workspaces and the web about 4%): each change rewrote the whole
cached history after it. A model step set to `freeze: "summary"` (front door or
job step; `packages/tex/gateway/agent/frozenModules.js`) sends these modules with the
words of the chat's first turn of the day, kept in the chat's own home
(`texStore/frozen.js`, beside the ledger, two days at most, wiped with it). What
changed since is said after the history, in the turn's preamble, and wins. The
day is the person's own, the one the chat's summaries are written for, so the
next summary and the next freeze start together. A turn with no home (the app, a
shared workspace's own connection) reads every turn as before.

**What a simplification would cost.** Reading the modules each turn again is one
config value (`freeze: "turn"`). Freezing a module that changes per text (a
job's brief, its parts) would put its whole text in the note on almost every
turn; those stay out of `FROZEN_MODULES`. Test: `apps/mcp/test/frozenModules.test.mjs`
(sabotage lines in its header), `texModuleChange.test.mjs`.
