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
