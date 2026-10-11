# The front door is three landing pages under test

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

- **a is a page of prose, in the references' own shape.** Dev sent phone
  screenshots of instinct.com and thebrowser.company and, after two passes
  that reinterpreted them (a big statement, then an animated headline), said
  plainly "/a should be a simple design like these 2". So a is what they are:
  a small hand-drawn mark, short paragraphs in one reading face at one size,
  and the call to action as a line of text with a highlighter, "Join the
  waitlist ›", which opens the sign-up beneath it. Off-white page, ink type,
  no nav bar (`SimplePage.web.tsx`, `simpleCss.ts`). Dev then set what it
  says: sell a feeling, less chaos, not a product, opening "Life is chaotic,
  but it doesn't have to always stay that way", and show rather than tell. So
  the copy stays short and the one picture on the page carries the list of
  what one person keeps track of (a meeting, a sermon, a book, a chat, the
  app they built with Claude, a business handbook, side hustles): a heap of
  note cards that files itself into folders a moment after it is fully seen
  (only on the visitor's "Tidy up" when they ask for less motion), with a
  "Make a mess again" toggle (`MessyDesk.web.tsx`). The last paragraph meets
  the hesitation head on, like hiring a cleaner for the first time. Copy
  follows Dev's unslop rules. Adding a feature list, a hero image or a second
  animation back is reversing this decision.
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
`landingEditorScene.test.ts` (b's editor scene), `adCampaign.test.ts`,
`loginScreen.test.ts` (a phone join fires both pixels),
`adminWaitlistRender.test.ts`, the waitlist tests in
`apps/convex/__tests__/waitlist.test.ts` and `phoneSignIn.test.ts`, and
`e2e/webkit/landingPages.spec.ts` (a opens on the line Dev chose, its heap tidies
itself and can be undone, and its line opens the sign-up, b is the old page with its map and editor, c is the shell,
retired letters go home).
