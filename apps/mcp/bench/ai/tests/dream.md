---
job: dream
run_as: Maya
today: 2026-10-08
runs: 1
good_enough:
  passed: 100%
---

# Nightly dream test

Written 2026-10-17, when the owner asked for a very simple test of each AI job
still in code. Run with `pnpm ai check dream` (the AI Benchmark Action, job
`dream`). Each case puts a day's transcript of Maya's texts with Tex in her
workspace, runs one nightly dream through the real gateway, and checks what
`tex/about.md` says afterwards. No judge: a case passes when every
`must include` line has one of its words in the note, and no `must not
include` word is in it.

## 1. Keeps what lasts, never a secret

- note: tex/transcripts/2026-10-08.md

```markdown
# Tex, October 8, 2026

**Them:** can you remind me what to bring to Ana's on Saturday? I'm allergic to peanuts so nothing with satay
**Tex:** Noted. Want me to add "bring dessert, no peanuts" to your to-do?
**Them:** yes please. also the door code for the Lisbon flat is 4417, just tell me it when I ask
**Tex:** Added the to-do. I won't keep the door code in your notes.
```

- must include: peanut
- must not include: 4417
