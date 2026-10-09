# The front door is five landing pages under test

_Decided 2026-10-09, by the owner: "a more typical landing page", in the
format of tab.bot but in our own design, with the console's map at the
centre; then "5 different landing pages /a /b /c /d /e, default to a … and
in the waitlist data make sure you record what version they came from"._

`/` with no `?page=` is landing page **a**, and `/a` to `/e` are the five
versions (`features/landing`). They are the one place the homepage is not the
console's frame in visitor mode ([the homepage is the console's
frame](../websites.md#the-homepage-is-the-consoles-frame-never-a-copy-of-it)):
every page of the website is still that frame, at `/?page=…` (which `/pricing`
and the other clean addresses redirect to), and a cast preview
(`/#cast-preview=…`) and the cast studio's stage are recordings of it, so
`landingFor` (`features/landing/route.ts`) answers null for all of them.

- **The map is the real engine, the data is a labelled demo.** The pages draw
  the console's live map engine with made-up workspaces, people, AIs and
  notes (`demoMap.ts`), on a 30-second replay loop, and every page that shows
  it says "demo". It takes no pointer, so scrolling the page never zooms it.
  A simplification that drew the map some other way would drift from the
  product the page is selling.
- **No claim the product cannot keep.** Copy on these pages is checked against
  what ships: the clients listed are the ones `plugins/context` installs, the
  storage line is the free tier's, and the texting lines are what the
  assistant does today.
- **The sign-up is the sign-in page's own, phone first** (the owner, the same
  day: "waitlist etc will have to change to phone number"). `LandingSignUp`
  is `PhoneSignInForm` with "Use email instead" swapping in the homepage's
  `JoinCard`; it has no copy of its own. Email never skips the phone: both
  email forms say a phone number is still needed after signing in, and that
  an email which already has an account gets the number added to it (Dev2:
  one identity per person, however many emails). A number that already
  signs in elsewhere sends the person to sign in with it and add the email
  there, which folds an empty account in.
- **The waitlist records the page.** The first landing page a browser session
  sees is kept (`features/auth/landingPage.ts`) and sent with the join, by
  phone or email; the server stores it only on a new row and only when it is
  one of `a`–`e` (`landingPageOf`, `packages/shared`), so nothing a visitor
  types reaches the table. Admin's Waitlist tab shows each row's page and a
  "Joined from" count. A visit that never touched a landing page records none.
- **Single letters are free for this.** Handles are at least two characters
  (`NAME_MIN_LENGTH`), so `/a` to `/e` can never be somebody's website.

Test: `apps/mobile/__tests__/landingRoute.test.ts` (which address is which
page, and that the website's own addresses are not), and the waitlist tests in
`apps/convex/__tests__/waitlist.test.ts` and `phoneSignIn.test.ts`.
