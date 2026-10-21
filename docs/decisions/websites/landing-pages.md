# The front door is three landing pages under test

_Page a was replaced by the Tex page on 2026-10-18, then by the notes page on
2026-10-21; see its entry below._

_Decided 2026-10-11, by the owner, replacing the five pages of 2026-10-09:
"a more simple design for the landing page similar to thebrowser.company and
instinct.com … root (/a) being the simple version, /b being the map variant
and /c being the variant where the landing page was the app shell. I'm going
to run ads on the 3 variants so make sure I can track where the sign ups are
coming from."_

`/` with no `?page=` is landing page **a**, and `/a` to `/c` are the three
versions (`features/landing`). Every page of the website is still the
console's frame in visitor mode ([the homepage is the console's
frame](../websites.md#the-homepage-is-the-consoles-frame-never-a-copy-of-it)),
at `/?page=…` (which `/pricing` and the other clean addresses redirect to),
and a cast preview (`/#cast-preview=…`) and the cast studio's stage are
recordings of it, so `landingFor` (`features/landing/route.ts`) answers null
for all of them.

- **a is the notes page** (decided by the owner, 2026-10-21, replacing the
  Tex page of 2026-10-18 now that tex.lc has its own: "since we have tex.lc
  and that is more text focused, context.lc's homepage should look more notes
  focused", then, picking option A of four, "I like A, but also want to show
  that you can create different workspaces for free"). The headline is "A
  notes app that every AI you use can read.", then the sign-up, the editor as
  a still picture (folders, one shared note, who and which AI is in it), four
  lines of what Context is, a workspace for each part of your life with the
  free line, and "Tex comes built in", which links to tex.lc rather than
  drawing a conversation (`NotesPage.web.tsx`, `notesParts.web.tsx`,
  `notesCss.ts`). It is on the brand's Paper, Libron for headlines, Instrument
  Sans for the rest, light only. It scrolls; what must fit the first screen,
  laptop or phone, is the sign-up. Drawing a chat here again makes context.lc
  a second tex.lc, which is what this reversed.
- **The free line is the server's numbers.** "Free: up to 10 workspaces, 1,000
  notes in each" is `MAX_WORKSPACES_PER_USER` and `FREE_MANAGED_NOTE_CAP`;
  `notesLanding.test.ts` fails if either moves without the page. Every person,
  note and workspace drawn is made up, and each picture says so (never the
  owner's own name).
- **a's sign-up button says what it does.** A labelled phone field with +1
  and a country drop-down, and beside it a solid "Join the waitlist" button
  ("Sign in" on the code step), full width on a narrow phone. The bare › of
  2026-10-12 was the thing nobody saw. The rules are still the sign-in page's
  (`usePhoneSignIn`), and "Use email instead" still swaps in the `JoinCard`.
  Its styles are its own (`signUpCss.ts`). Rows recorded as `a` before
  2026-10-18 saw the page of prose and its graph, from 2026-10-18 to
  2026-10-21 the Tex page.
- **b is the page `/` showed until 2026-10-11, unchanged** ("b/ should be the
  current default page"): tab.bot's shape in our colours, the live map behind
  "Less chaos", the real editor playing a demo, the prose, and the sign-up
  card (`variants.web.tsx`; its classes keep their old `lp-a-` names).
- **c is the shell itself.** "The landing page was the app shell" means the
  console's frame in visitor mode, drawn by `HomeShell`, not a picture of it.
  It differs from `/?page=index` only in being counted as page c.
- **The map and the editor are the real engines, the data is a labelled
  demo.** b draws the console's live map engine with made-up workspaces,
  people, AIs and notes (`demoMap.ts`), and under it the homepage's own shell
  plays a made-up scene in an iframe (`LandingEditor.web.tsx`,
  `editorScene.ts`), each saying "demo". Never a screenshot: they change when
  the console does.
- **No claim the product cannot keep.** The clients listed are the ones
  `plugins/context` installs, and the texting and download lines are what
  ships today.
- **The sign-up is the sign-in page's own, phone first.** `LandingSignUp` is
  `PhoneSignInForm` with "Use email instead" swapping in the homepage's
  `JoinCard`; it has no copy of its own.
- **The waitlist records the page and the ad.** The first landing page a
  browser session sees (`features/auth/landingPage.ts`) and the first UTM
  parameters it arrived with (`features/auth/adCampaign.ts`) are sent with
  the join, by phone or email. The server stores them only on a new row:
  the page only when it is one of `a`–`c` (`landingPageOf`), the campaign
  trimmed, stripped of control characters and capped per field
  (`adCampaignOf`, `packages/shared`), so nothing a stranger types reaches
  the table unbounded. Admin's Waitlist tab shows each row's page and ad, a
  "Joined from" count per page and a "From ads" count per page and ad. Rows
  from before 2026-10-11 keep their old letter, and `a`–`c` before that date
  were the earlier designs.
- **A phone sign-up is an ad conversion too.** A phone join returns the same
  conversion id an email join does, and the page fires the X and Meta
  sign-up events with it, so an ad counts the form these pages lead with.
  The server-side conversion APIs still hash an email only, so a phone join
  is reported from the browser alone.
- **Retired letters go home.** `/d` and `/e` redirect to `/`, so an old ad
  or link never lands on "Nothing here".
- **Single letters are free for this.** Handles are at least two characters
  (`NAME_MIN_LENGTH`), so `/a` to `/e` can never be somebody's website.

Test: `apps/mobile/__tests__/landingRoute.test.ts` and `landingPages.test.ts`
(which address is which page, and how a campaign is read and cleaned),
`landingEditorScene.test.ts` (b's editor scene), `landingInlineSignUp.test.ts`
(a's sign-up), `chaosFigure.test.ts` (Tex), `adCampaign.test.ts`,
`loginScreen.test.ts` (a phone join fires both pixels),
`adminWaitlistRender.test.ts`, the waitlist tests in
`apps/convex/__tests__/waitlist.test.ts` and `phoneSignIn.test.ts`, and
`e2e/webkit/landingPages.spec.ts` (a opens on Dev's line, the whole conversation shows at once
with nothing animating, a phone from 375 to 430 wide gets the phone sizes with the button under the field, the sign-up and the conversation fit a laptop's first screen, the button says "Join the waitlist",
b is the old page with its map and editor, c is the shell, retired letters go home).
