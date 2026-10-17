---
job: texting-assistant
run_as: Nia
today: 2026-10-08
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 1
web: scripted
good_enough:
  score: 100%
  voice: 80%
  price: under $0.10 a question
  speed: under 120 s
  texts: 6 or fewer
---

# Onboarding

A group for Tex's onboarding, asked for by Dev2 on 2026-10-17: "I feel like this should be a whole new question group just for onboarding." The cases follow the [Tex onboarding flow](https://claude.ai/artifact/35mHbKqBHjnunKfp1CZRJe) and Dev2's decisions of 2026-10-17: handle before Gmail (the handle is the setup state machine's, `apps/agent/src/setup.ts`, so no model case covers it), Gmail before any AI, 50 emails, Google only, confirm the login email instead of asking permission to use a sign-in code, a shared AI account connects without private access, no morning brief offer.

They run as Nia (`workspaces/people.md`): set up by text a few minutes ago, with only the five starting folders, no `tex/about-me.md`, and the ten emails Gmail's first import brought. Each case is a fresh conversation from that state. Rewritten on 2026-10-17 for the leadership meeting's weekly priority (onboard two people by text with no hiccups) from the eight first drafts, which assumed a fixture nobody had built (Maya, a workspace full of notes) and a handle step no model runs.

`runs: 1` keeps a screen cheap under the $20 loop cap; use 3 runs only to check a promotion. Run it with the Action's `test: onboarding`.

## 1. ready

The first text after setup ("text me ready and we'll connect your email"). Tex starts onboarding with Gmail and warns that the page signs them in by phone first, since someone set up by text has never signed in to the app.

- kind: task
- drafted: Claude (2026-10-17)
- must call: read_skill
- must: send the link to connect Gmail on its own line
- must: say in one line why (so Tex can get to know them from their recent email)
- must: say the page first asks them to sign in with their phone number, or for their email
- must not: ask for a password or a code by text
- must not: list every onboarding step in one reply

## 2. ok gmail's connected

Tex reads the recent email, writes a first About me with whether they code, starts the first dream, and texts back a short summary to confirm.

- kind: task
- drafted: Claude (2026-10-17)
- must write: nia/tex/about-me.md
- must: say what it learned in two or three short lines: that she works on a product at Fernway, runs Lumen Studio on the side, and uses Claude and ChatGPT
- must: ask her to confirm or correct it
- must not: quote an email back word for word
- must not: get a fact wrong about her (a name, a date, an amount)

## 3. yep that's right

After the About me is confirmed, the next step is her AI: Tex asks which one, one question at a time.

- kind: task
- drafted: Claude (2026-10-17)
- must: ask whether she uses ChatGPT, Claude or both, or offer to connect the ones her email shows
- must: ask one thing only
- must not: offer a morning brief or list what Tex can do

## 4. I use Claude, but it's the Fernway team account

A shared account connects without private access, so it sees anything labeled team and never private notes (Dev2's own example). Tex confirms the login email first instead of asking for permission to read a code.

- kind: task
- drafted: Claude (2026-10-17)
- person starts: "I use Claude, but it's the Fernway team account"
- if asked whether she signs in with Gmail or another email, or which email: "nia@fernway.example, it's a work email"
- if asked to enter a code, sign in, or open a link: "Done"
- if asked whether to go ahead: "Yes, go ahead"
- must: confirm the email she signs in to Claude with before signing in ("Is nia@fernway.example the right email?")
- must: say her private notes won't be visible to the shared Claude
- must not: ask for a password or a code by text
- must not: remove or overwrite her existing custom instructions without asking

## 5. I also run a small design studio on the side, Lumen Studio, with Theo

A side business gets its own shared workspace with the business layout, separate from the personal one, and the handle waits for her yes.

- kind: task
- drafted: Claude (2026-10-17)
- must: offer to make a separate workspace for Lumen Studio
- must: check or suggest a handle and wait for her yes before claiming it
- must not: put the studio's clients or invoices in her personal workspace
- must not: say the workspace is made before she said yes

## 6. yeah I code, I use Claude Code a lot

Technical matters because of coding (Dev2, 2026-10-17): coding work that never reaches Context makes Context look like it does nothing. A person who codes gets the plugin's one install command.

- kind: task
- drafted: Claude (2026-10-17)
- must: offer the Claude Code plugin with its one install command on its own line: npx @supa-media/context
- must: say it keeps her coding work in Context
- must not: explain what MCP is

## 7. it's all connected. anything else?

The backfill: Tex fills her workspace with what her email shows, one short note per thing, and says what it added.

- kind: task
- drafted: Claude (2026-10-17)
- must write: nia/1-projects/
- must: say in a line or two what it added and where
- must: ask "Anything missing?" or similar, once
- must not: write a fact her email doesn't give (an amount, a date, a name)
- must not: offer a morning brief
