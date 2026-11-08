# Tex sets things up itself, and hands back only what a person must do (2026-11-08)

Decided by Dev2, 2026-11-08: "we should never really make functionality that
only humans are native to like setting up a computer by pressing UI etc. for
something like sharing their computer with a group, it should definitely say
the things that only they can do but do the other things themselves. OR give
them a prompt to hand an agent working on their computer if need be, people
don't want to click buttons anymore." Dev2 picked "Tex does it, plus rule and
CI" on the options for the diagnosis
(`@supa projects/tex/handoff/2026-11-08-setup-not-buttons-diagnosis.md`).

## What happened

In Tex Devs on 2026-11-05, Seyi asked people to add their computers "for
community compute". Jhon asked for a prompt for his agent. Tex said the feature
"isn't built yet" (it had found a stale note) and offered the Linux app for a
MacBook. "Tex add my computer for community compute" got "Connect it on your
own Tex page first. Then you can lend it to this chat from the machines page."
Every step (approving a pairing, lending, rules, limits, install, sign-in,
disconnect) was a console-only route (`apps/mcp/src/machines/appRoutes.js`), and
Tex had no tool for any of it. The pairing path Tex found in the notes
(`manage pair_device`) only makes a mail-only device, which never takes a job
or a lending. The working agent prompt on `context.lc/download` was unknown to
Tex.

## The rule (agent-first)

- **Every feature ships with a Tex path.** What a person can do in the app,
  Tex can do from a text, or the feature lists the step only a person can take
  and what Tex says or hands for it: a prompt for the agent on their computer,
  a link, an app path, or a vault entry. "Go to the settings page" is never
  the whole answer.
- **What only a person can do** is signing in with their own account on the
  maker's page (OAuth), approving something whose code only they can see, and
  running a command on a computer Tex isn't on yet. Tex names exactly that
  and does the rest.
- **Kept honest by CI.** The capability list (`apps/mcp/src/agent/capabilities.js`)
  names each app route it covers (`appRoutes`), and its test fails when a
  console route under `/machines/app/*` is on no line. Lines that are still
  person-only carry a `cant` entry with the workaround, and a pull request that
  gives Tex the capability removes that entry.

## Computers, from a text

`send` action `computers` (`apps/mcp/src/machines/texActions.js`), for a
person's own texts and a group chat's turn (never a guest's tag):

- `setup_prompt` hands the coding-agent prompt for Mac, Linux or a headless
  server (`setupPrompt.js`), the same words as `context.lc/download`
  (`installGuide.ts` `agentInstructions`; `installGuide.test.ts` holds them
  equal). The agent is told never to approve the code itself.
- `pair` approves the code when the person texts it to Tex **in their own
  1:1 only**, through `/gateway/machines/pair/approve-texts`
  (`functions/texMachineTexts.ts`): only a `context_texts` grant, into its own
  workspace, the app's role rule and the same ten-in-ten-minutes budget, a full
  computer. Never in a group: anyone there could approve a code read out into
  their own account and run their jobs on the computer. The code must be in
  the person's own message.
- `lend` / `unlend` lend the computer to the group chat the turn is in, with
  who may use it (everyone, only them, or @handles) and Ask me first, the way
  the app's lend does (control plane lending, then the rule in the object).
- `rename`, `limits`, `more_time`, `install`, `sign_in` (1:1 only, since the
  link signs an account in; a Claude Code code comes back with
  `sign_in_code`, verbatim in their words) and `disconnect`.
- **Who acts.** Only the grant's person (the tagger in a group), on their own
  computers, which the control plane lists by that id (`texMachinesOwnedBy`)
  and the gateway re-checks against each computer's own `ownerId`. Never a
  workspace owner on someone else's computer. Every change needs the turn's
  own words (a computer word, then the same judge as any widening). Another
  member's text, a quote or an email changes nothing.

Not built yet, and listed as person-only: answering "Ask me first" from a 1:1
(the group 👍 works), the Mac app's "Let Tex use this Mac" switch and its
folder picker, and computer use.

Tests: `apps/mcp/test/machineTexActions.test.mjs`,
`apps/convex/__tests__/texMachineTexts.test.ts`, whose headers record their
sabotage. A simplification that drops the 1:1-only pairing check, the
own-words check or the owner re-check fails them.
