# The front door is three landing pages under test

_Page a was replaced by the Tex page on 2026-10-18; see its entry below._

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

- **a is the Tex page** (decided by the owner, 2026-10-18, replacing the
  page of prose and its graph: "we need a new landing page, one that is more
  Tex/Chat focused … Text your notes we'll organize it for you … right now
  the page has the complex graph that confuses people, and also signing up
  for the waitlist the button to click enter isn't clear"). Dev's line is the
  headline, "Text your notes. We'll organize them.", then one sentence of what
  Tex takes (a thought, a link, a photo, a voice memo or a PDF), the sign-up,
  and beside it one conversation with Tex (`TexPage.web.tsx`, `TexChat.web.tsx`,
  `texCss.ts`). It keeps the old a's sheet, Libron and light-only look, so it
  is the same site.
- **a's picture is one conversation, not a diagram.** Dev then asked for it
  to show "something a bit more useful, like sending an email doing something
  research, but it should all fit on a page", and for Tex to sound like a
  person ("'Text YES to send' seems very robotic"). An idea becomes a note in
  Projects; a search for a place finds three and adds them to that note,
  whose link Tex texts; an email is shown as Tex would send it and goes on a
  yes; Tex says it will send a reminder. Each is something Tex does
  today: web search (`agent/search.js`), the note's link on a texted write
  (`agent/noteLinks.js`), the email send-review gate, routines. The link is
  drawn as the card a note's link really unfurls as, Context's own, never
  with the note's name. Every bubble is laid out from the start and the
  thread fills the card from the bottom, so nothing moves while it plays; it
  starts when on screen, plays once and holds the end, and a visitor who asks
  for less motion sees the end at once. Tex, the mark, starts as a scribble
  and settles into the # as the conversation is filed. On a computer the
  whole page fits the window with no scrolling (on a short window the chat's
  header folds to one row); on a phone the sign-up comes before the
  conversation. Putting the graph, a feature list or a second animation back
  is reversing this decision.
- **a's sign-up button says what it does.** A labelled phone field with +1
  and a country drop-down, and beside it a solid "Join the waitlist" button
  ("Sign in" on the code step), full width on a narrow phone. The bare › of
  2026-10-12 was the thing nobody saw. The rules are still the sign-in page's
  (`usePhoneSignIn`), and "Use email instead" still swaps in the `JoinCard`.
  Rows recorded as `a` before 2026-10-18 saw the page of prose and its graph.
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
`e2e/webkit/landingPages.spec.ts` (a opens on Dev's line, the conversation plays to its end
or shows at once with less motion, the sign-up and the conversation fit a laptop's first screen, the button says "Join the waitlist",
b is the old page with its map and editor, c is the shell, retired letters go home).
