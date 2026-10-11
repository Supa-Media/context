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

- **a and b are one sentence, a few lines and one action.** The references
  are a page with a single large sentence and almost nothing else. a is that
  sentence ("Context is one set of notes for you, your team, and every AI you
  use"), a short paragraph and the sign-up card, fitting one laptop screen;
  b is the same restraint beside the live map. No feature grids, screenshots
  or prose sections: adding them back is reversing this decision. The blue
  square is the sentence's full stop and follows the wordmark.
- **c is the shell itself.** "The landing page was the app shell" means the
  console's frame in visitor mode, drawn by `HomeShell`, not a picture of it.
  It differs from `/?page=index` only in being counted as page c.
- **The map is the real engine, the data is a labelled demo.** b draws the
  console's live map engine with made-up workspaces, people, AIs and notes
  (`demoMap.ts`) and says "Demo". It takes no pointer, so scrolling never
  zooms it.
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
`adCampaign.test.ts`, `loginScreen.test.ts` (a phone join fires both
pixels), `adminWaitlistRender.test.ts`, the waitlist tests in
`apps/convex/__tests__/waitlist.test.ts` and `phoneSignIn.test.ts`, and
`e2e/webkit/landingPages.spec.ts` (a fits one screen, b labels its demo, c is
the shell, retired letters go home).
