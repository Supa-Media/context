### The first run is two screens, and the rest is a checklist in the console (2026-09-25)

The owner's design canvas draws the first run as **Sign in → Code → Handle →
Fork → "Take me to the console →"**, with one side track for somebody who
already has a bucket (Point at it → the report of what we found → the
console). What shipped before this was a ten-step wizard — name, fork,
storage, dry run, vault import, layout, tools, bootstrap, a "waiting for your
first tool" screen and a closing summary — and the owner's review of it on
staging was "why do we have 9 steps at onboarding… what I designed as the
screen is not what I can see here."

So the wizard stops at the fork. Everything after it is the canvas's
**"Set up @you · n of 4"** widget (W-07), floating over the owner's own
personal workspace: *handle, storage, notes, tools* (the last opening into
Claude, ChatGPT and the bootstrap prompt), with "You're set up." (A-09) drawn
over the workspace once all four are true. It lives in
`features/console/setupWidget/`.

- **"Start fresh" means the canvas's promise**: our bucket *and* the five
  standard folders, then the console. The layout is asked for the moment the
  bucket we made verifies, best-effort — a layout that fails to queue still
  lets them in, and the workspace's own band offers it again. A bucket
  somebody *brought* is never written a layout from the first run: the report
  comes first, and the console's `SetupPrompt` is the only thing that offers.
- **The folders are drawn being written in the console, not before it.**
  Queuing the layout returns at once; the job takes a few seconds, and the
  first owner to sign up spent them looking at a fails-closed warning that
  `privacy.md` was missing. The binding now carries `scaffoldQueuedAt` from
  the queue until the job reports back, so the console opens knowing a layout
  is on its way and draws the folders with spinners (`LayingOutFolders`) in
  the document area, where a note would be — one line and a row of chips
  beside the sidebar, never a band across the whole pane — ticks them once it
  lands, and re-reads the root. The warning and the
  "empty" card wait for the truth, and a stamp nobody answers stops counting
  after two minutes. A holding screen in `/welcome` was built first and
  replaced the same day: the owner wanted the person in their workspace, with
  the folders arriving there. `browseSetupPrompt.test.ts` ("a layout on its
  way") fails if the warning comes back, and `onboardingMount.test.ts` fails
  if the first run waits.
- **Every row is done because of a fact**, never because somebody pressed past
  it: storage when the binding verified, notes when there are notes or a
  layout we wrote, tools when a client has actually called. `rules.ts` is
  pure, and `setupWidget.test.ts` fails if a row turns green on anything less.
- **Who sees it**: the owner of a *personal* workspace, at pointer widths,
  outside the demo, once the device has answered whether it was put away.
  Members get the shared welcome (`sharedWelcome.ts`); a phone keeps the
  workspace's own band, which carries the same offers inline.
- **Put away is a device flag**, for `contextIntro.ts`'s reason: whether a
  person has finished with a checklist is a fact about them on a screen.
- **Onboarding's primary action is the accent button.** The canvas draws every
  primary on these screens teal, and a secondary action beside it as an
  underlined link (`TextLink`) on the same line — never a bare ghost label
  floating at the other end of the row, which is what the review called out.
  Deleting a row somebody typed is a bin (`DeleteButton`), not the word
  "Remove"; removing something that already exists stays the two-step
  Remove → Confirm.

What a "simplification" would cost: putting the layout, tools or summary back
between the fork and the workspace is the ten-step flow this replaced.
`onboardingFlow.test.ts` ("there are four screens at most") fails if a fifth
screen is added.

## Connecting an AI is a guide that checks itself (2026-09-25)

The setup widget's last row is "Connect your AI", and it offers two tiles,
Claude and ChatGPT. Each tile opens a full-screen guide at `?connect=`, drawn
beside `?settings=` so the note stays open underneath. The owner reviewed the
artboards on 2026-09-25 and decided three things:

- **The Claude app only.** The guide has no "which Claude" picker and no
  Claude Code step. Claude Code keeps its own row under Settings.
- **Every guide has a "Make it stick" step.** It hands over the one standing
  instruction, `CLAUDE_CUSTOM_INSTRUCTION` in `onboarding/agents.ts`, pasted
  into each agent's own custom-instructions field. A connector that the agent
  never consults is one that people give up on.
- **Bringing over what the agent knows is the last step, and it is the check.**
  One prompt (`agentSetup/bring.ts`) asks the agent to orient, say where each
  note will go, wait for the person's go, write only what it knows, and finish
  with a "Getting started" note.

The guide moves on by itself, and only on facts the product already records:

- A live grant for that client means signed in.
- The gateway's agent-activity marks mean read and wrote.

No new backend was added. The "Getting started" note arriving is what ends the
run, so an agent with an empty memory still passes. It is told apart from a
full run, and the finish screen tells the person how to turn memory on.

"Make it stick" is the one step that nothing can observe, so it takes the
person's word. Two things the guide cannot see are covered by copy rather than
by a check:

- **ChatGPT's Deny.** It looks the same as "nothing written", so the stalled
  screen covers both.
- **An agent writing to the wrong workspace.** This would need a second
  workspace's activity, and it is not detected yet.

The guide is not offered to a shared workspace's owner, because `listGrants`
shows an owner every member's grants.

What a "simplification" would cost:

- Ticking steps on a click would bring back the "connected" that nothing had
  connected.
- Dropping the bring-over step leaves a workspace that is still empty after
  setup.

`agentSetup.test.ts` fails if a step turns done on anything but a grant or a
mark, or if the prompt loses a guardrail.
