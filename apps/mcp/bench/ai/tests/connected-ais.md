---
job: connected-ais
run_as: Maya
today: 2026-10-08
runs: 1
good_enough:
  passed: 100%
---

# Connected AIs test

Written 2026-10-17, when the owner asked for a very simple test of each AI job.
Claude, ChatGPT and other apps bring their own models; what Context gives them
is the MCP server's instructions and its tools. Run with `pnpm ai check
connected-ais` (the AI Benchmark Action, job `connected-ais`). The stand-in
client is a plain Claude model given nothing but those, asking as the person
named; the tools it called, in order, and its answer are checked. No judge.

## 1. Orients first, then answers from the notes

- input:

```text
What's on my to-do list?
```

- must include: Tools called: orient
- must include: Lisbon
