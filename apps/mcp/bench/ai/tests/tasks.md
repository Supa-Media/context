---
job: texting-assistant
run_as: Maya
today: 2026-10-11
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 3
web: scripted
good_enough:
  score: 100%
  price: under $0.05 a question
  speed: under 90 s
  texts: 4 or fewer
---

# Golden tasks

Decided by the owner on 2026-10-11, after a texted conversation in which Tex could not check whether ChatGPT was set up, said it could not use a site without a saved login, and promised a browser link that never came: "we need to establish some golden tasks that Tex MUST do well." These are those tasks. A setup that fails any of them, on any run, is not good enough, whatever else it scores.

Every task is `kind: task`, which makes it a gate: a failed must or must-not line, a failed check, or an unanswered run fails the setup. Judge lines grade nothing.

The web is scripted (`web: scripted`): every site lives in `sites/`, served by a stand-in for the browser Worker, and nothing reaches the real web. The person signs in only through a handoff: after Tex hands its browser over, the person's next text comes once they have signed in on that site. The `must call`, `must reach`, `must hand off`, `must type`, `must choose` and `must set` lines are checked from the run's record (`bench/checks.mjs`), never by the judge.

How Tex should do each one lives in the setup's skills (`setups/texting-assistant/skills/`), which production reads from `ai/production/skills/`. A task here names what must happen, never how; a skill says how.

## 1. Can you make sure my ChatGPT is properly set up to use Context?

From the 2026-10-10 conversation. Maya's ChatGPT has never been connected.

- kind: task
- person starts: "can you make sure my chatgpt is properly set up to use context"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- if asked whether to go ahead: "Yes, go ahead"
- if asked which plan she has: "Plus"
- must call: read_skill
- must reach: chatgpt.com/plugins
- must hand off: chatgpt.com
- must type: https://mcp.context.lc/mcp
- must choose: Authentication: OAuth
- must set: connected chatgpt
- must not call: vault_add_link
- must: end by telling Maya that ChatGPT is now connected to Context
- must not: ask Maya for a password or a sign-in code in a text
- must not: say it cannot use the browser, or cannot use ChatGPT without a saved login

## 2. Set up Claude so it can use my context

- kind: task
- person starts: "set up claude so it can use my context"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- if asked whether to go ahead: "Yes"
- must call: read_skill
- must reach: claude.ai/customize/connectors
- must type: https://mcp.context.lc/mcp
- must set: connected claude
- must choose: Read-only tools: Always allow
- must choose: Write/delete tools: Always allow
- must not call: vault_add_link
- must: end by telling Maya that Claude is connected to Context and will use it without asking each time
- must not: ask Maya for a password or a sign-in code in a text

## 3. Save my Streamly login so you can sign in for me

- kind: task
- person starts: "can you save my streamly login so you can sign in for me next time"
- must call: vault_add_link
- must: send Maya a link to save the login herself
- must: say the link is private to her and expires after 30 minutes
- must not: ask Maya to text her password or username
- must not: claim the login is already saved

## 4. When does my Streamly plan renew?

No login is saved, so Tex signs in through Maya: it opens the sign-in page and hands its browser over, then reads the account page once she has signed in.

- kind: task
- person starts: "log in to streamly.example with maya@example.com and tell me when my plan renews"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- must reach: streamly.example/login
- must hand off: streamly.example
- must reach: streamly.example/account
- must: say the plan renews on November 2, 2026
- must not: ask Maya to text her password
- must not: say it cannot sign in because no login is saved

## 5. Find me the cheapest flight from Lisbon to London on November 14

- kind: task
- person starts: "find me the cheapest flight from lisbon to london on nov 14 on harborair.example"
- if asked whether to book it: "No, just tell me"
- must reach: harborair.example/results
- must not set: started booking
- must: say the cheapest is HA 219, leaving at 19:30, for 71 euros
- must not: say it booked or started booking a flight
- must not: say it cannot browse websites
