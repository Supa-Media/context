# The texting assistant — setting somebody up by text

_Part of [the texting assistant](../texting-assistant.md)._

### A phone let in off the waitlist is set up by text, handle first

Decided by the owner (Dev2), 2026-10-17: onboarding happens by text, the
handle first, Gmail and the rest later in the conversation. Somebody let in
off the waitlist is texted "Text Tex at X and Tex will set you up"
(`waitlistText.ts`) and put on Tex's line (`waitlistTex.ts`). Until this, Tex
answered them with the sign-in link, because they had no account, no
workspace and no link, so the promise in that text was not kept.

Now an unlinked phone the control plane may set up gets a fixed exchange
instead of the link (`functions/textSetup.ts`, `apps/agent/src/setup.ts`):

1. Any text: Tex asks for the handle they want. A row remembers that it
   asked (`textSetups`, stage `asked`, a day at most).
2. The next one-word text is the answer, checked with the app's own rules
   (`checkAvailability`: format, the reserved list in `lib/names.ts`, taken).
   A refusal says why, and Tex asks again. Twenty setup texts per phone an
   hour.
3. A good handle makes, in one transaction: the account if the phone has
   none (`newPhoneAccount`, the same as `signInUser` for an admitted phone),
   the personal workspace through `createWorkspaceHandler` (every check
   `createWorkspace` makes), the free managed bucket where the deployment
   offers one (what "Start fresh" gives, `lib/textSetup/storage.ts`), and the
   phone's link. Tex texts the console link for the new handle on its own.
   The five starting folders are laid out when the bucket first verifies
   (`lib/textSetup/layout.ts`, through `applyStructureHandler`), only on our own
   bucket and only when the probe saw it empty, as the app does after "Start
   fresh". The next text is an ordinary linked session.

### Tex never texts first; everyone let in is told its number (2026-10-17)

Decided by the owner (Dev2), 2026-10-17: "we have to have people texting
Tex first, so using twilio we should ask people to 'text this number'". Tex
does not open a chat. Instead, the "You're in! Text Tex at …" SMS
(`waitlistText.ts`, through the Twilio Messaging Service) reaches everybody
let in whose phone is on Tex's line, not only rows joined with a phone: a row
let in by address gets it at Let in when its account already has a proven
phone, else when the person confirms one in the app (`waitlistTex.putOnLine`
calls `textTexNumber`). `admittedTextAt` is claimed before the send, so each
row is texted at most once whichever path reaches it. The "You're in" mail
says Tex's number follows by text once they add a phone. When Tex's number is known the SMS asks only that they text Tex, with no sign-in link: the link started a different setup, and the first onboarding test found it confusing (2026-10-17).

Tests: `apps/convex/__tests__/waitlistTex.test.ts` ("adds the proven phone of
the account that address signs in to", "with no phone yet, the phone is added
when the person confirms one"); dropping the claim's `admittedTextAt` check
fails both the re-admit and the address test.

**It is a state machine, not a model with tools.** The person has no grant
until the link exists, and a model given account-making tools before there
is a grant would be the one thing in the product deciding identity from what
somebody typed. The exchange cannot be talked into anything: the Worker
cuts out one word and the control plane decides. The words of the message
never leave the Worker; at most a single word reaches the control plane.

**Who may be set up.** Only what phone sign-in would let in, and nothing more:

- a phone nobody holds, once staff let it in (`isPhoneAdmitted`);
- a phone confirmed on an account (`phoneHolder`) whose account owns no
  personal workspace yet, is not paused by "This wasn't me", has no texting
  link to another number, and, if it came in through a work domain, has a
  personal email (the rule `finishSetup` applies). Its emails are mailed as
  for a phone sign-in.

Everyone else — a stranger, a waiting or removed row, the review phone, a
paused phone — gets the sign-in link as before. So does a control plane too
old to know the route (404), so the Worker can deploy first.

**Why the sender number is enough here, and where it is not.** The sending
number is the login for texts already: only iMessage is answered, Apple
authenticates its senders, a webhook is acted on only with Linq's signature
(unchanged), and only numbers on Tex's contact list are delivered at all. A
texted sign-in code proves the same thing, possession of the number, and
that is all `signInUser` asks of an admitted phone before making its
account. So this creates nothing a texted code could not. Two cases are
held back on purpose:

- **An account that already owns a personal workspace is never linked by
  this.** It keeps the link-and-code flow. A carrier recycles numbers, and a
  confirmed phone from years ago must not start answering from somebody's
  notes on the strength of one text; the code shown in the signed-in app is
  the second half of that proof. Setup also never makes a second account for
  a held phone, never moves a phone off an account, and never links a phone
  to any account but the one holding it.
- **A held account with no workspace of its own is set up as itself.** Its
  confirmed phone already signs it in with a texted code, which reaches its
  memberships too, so a link adds no reach that phone sign-in did not. The
  sign-in alert mail is the same one, with "This wasn't me".

The big changes in [account safety](../identity-and-access/account-safety.md)
stay behind an email code: this adds no email, changes no phone and moves no
storage.

**Audited under the person, through Tex.** `texts.setup.account_created`
(new accounts only), `texts.setup.workspace_created`, `texts.phone.linked`
(`via: "text_setup"`) and `texts.setup.storage_started`, each with the new
account as `actorUserId` and `context_texts` as `actorClientId`; the free
bucket and the layout add their own events (`billing.free_managed_started`,
`workspace.structure_applied`). Phone numbers appear in the trail only as
their last four digits.

An account made by a phone now also schedules the founding Premium walk, as
an account made by email always did (`onUserCreated`): without it, a texted
setup among the first hundred would have been told Tex needs Premium.

**A new account's founding grant is made inside setup, not left to the walk**
(2026-10-17, for the first onboarding test). Scheduled, the walk ran after
the bucket had already started as a free one, and its activation then started
a second provisioning beside it. Setup now runs the same walk in its own
transaction before making the workspace, so `createWorkspaceHandler` makes it
Premium from its first moment and the bucket starts once, as a founder's.
Past the first hundred nothing changes: the free bucket. Test: "past the first
hundred, a new phone starts the free bucket", and the storage test's founding
plan.

**Tex texts first once the notes are ready, with a link that signs them in**
(Dev2, 2026-10-18, reviewing the onboarding screens: "it should take a couple
of minutes, I'll let you know when I'm ready", and "since it's coming from
that number already, then it's pre-authenticated"). The setup text says Tex
will text when it is done and carries no link. The sender's inbox owes that
text (`apps/agent/src/ready.ts`): its alarm asks `POST /agent-texts/ready`
every 30 seconds, and once the workspace's binding is `connected` and its
folders are laid out, it texts a fixed line and a link to
`/signin/<token>` (`functions/textSignIn.ts`). After twenty minutes it says
it is taking longer and stops. Linq's line only reaches people who texted it
first, and they did, so this is not Tex texting first.

The link is a credential, so it is kept as narrow as a texted code: it signs
in only the account holding the phone it was texted to, through the same
`phone-verify` provider; it opens once, within a day; opening it (in the
page, not the request, so a link preview spends nothing) mints a ten-digit
code good for five minutes, which no six-digit texted code can collide with;
only hashes are stored; the destination is built by the control plane and
narrowed again by `safeNextRoute`. No model writes the text or sees the
link: the Worker fetches and sends it. What a "simplification" would cost:
minting the link in a model tool (`connect_google`) would put a sign-in
credential in front of a model that reads untrusted email and can send it.

A text sent before the notes are ready gets the gateway's 503
`storage_unavailable`, which the Worker answers with "Your notes aren't ready
for me yet…" (`COPY.noStorage`) rather than "Something went wrong on my side".

**Gmail first, and the first Gmail is the main email** (Dev2, 2026-10-20:
"we just go straight to asking them to add gmails, we should be clear that the
first should a primary personal gmail and then use that email as the primary
email and then we can ask them to add more"). The ready text asks for their
personal Gmail, the one they check most. The one-time email gate an account a
phone made meets (`gmailFirst/EmailGate.tsx`) leads with Connect Gmail, with
"Type an email instead" for the mailed code as it was. When Google returns,
`exchangeAndBind*` makes the address the account's main email before the
binding lands (`signInEmails.adoptGoogleAddress`): Google's `email_verified`
claim is the proof a mailed code would be, so nothing is mailed. Only the
first address of an account with none, never one another account holds, and
it never folds an account. Google's unverified-app warning is explained on
the page, where it happens, not in the text.

**Tex says so itself when that Gmail connects.** After the ready text the
sender's inbox watches `POST /agent-texts/gmail` (`apps/agent/src/gmailWatch.ts`:
every 30 seconds for half an hour, then every five minutes, for the day the
link lives) and texts a fixed line naming the address, whether it is now the
main email, and asking about other Gmails. Its answer is the next turn, which
the gateway knows about by name (`told`: `gmail_main`, `gmail`). Another Gmail
is `connect_google` kind gmail, which now opens `/add-gmail`, one Connect Gmail
button that leaves the main email alone.

**tex.lc signed in lands on `/text`, not the console** (Dev2, 2026-10-20):
"Text Tex." with the number, and Open console one quiet row under it. Open
Messages has "hi" typed for a phone that has never texted Tex (`texHome.mine`
`firstText`: no texting link and no setup under way). The landing, signed in,
swaps its number field for "You're signed in as •••• NNNN" and Text Tex.

**Asking for a Gmail link again still goes through the app's sign-in.** A link
the model sends (`connect_google`) asks for the phone number first if that
browser is not signed in, and for an account a phone made, the Gmail-first
gate.

**Tex asks whether they pay for ChatGPT or Claude** (Dev2, 2026-10-18): the
free plans can't connect to Context. And before any browser work it says what
it is about to do, that it may take a while, and that it will text when done.
Both live in the onboarding skill (`@context-lc ai/production/skills/onboarding.md`).

**Every Google link carries a heads-up about Google's warning** (Dev2,
2026-10-18). Until Google verifies the app, its consent screen says it hasn't
verified Context and calls going on unsafe. Met cold, that reads as a scam and
people stop; so the Gmail page under its button (since 2026-10-20, in place of
the ready text), `connect_google`'s answer and the skill all say it's expected
and to tap Advanced, then Go to Context.

Tests: `apps/convex/__tests__/textSetup.test.ts` ("an account that already
owns a personal workspace is never set up or linked by a text", "sets up that
account and no other", "is held to the app's handle rules", "never lays out a
bucket that is not our own, or one not seen empty") and
`apps/agent/src/setup.test.ts` ("the message's words never leave the
Worker", "texts no link but the console's"), `apps/convex/__tests__/textSignIn.test.ts`
(the link waits for ready storage, opens once, signs in no other phone, and
expires) and `apps/agent/src/ready.test.ts` (the ready text goes once, never
with a link that is not https), `apps/agent/src/gmailWatch.test.ts` (the
Gmail text goes once, only after it connects, never with something that is
not one address) and `apps/convex/__tests__/texHome.test.ts` (the first Gmail
becomes the main email and no other, never folds an account). Each file's header records the sabotage runs.

### Tex offers Google before it is asked, and shows Google's two screens (owner, 2026-10-23)

The owner, after an existing Context user texted Tex and had to ask for the
link to connect her Gmail: "make sure that whenever someone texts, that it
tells them, hey, connect your email, so we can be proactive about this ...
prepare them for the unsafe screen ... send them a picture of what it's gonna
look like and what they should click, and make sure they also click select
all".

- **Offered once, on a texted turn.** Somebody set up by text is asked for
  Gmail by the ready text; somebody who had Context first never saw it. Each
  texted 1:1 turn reads their mailboxes (`/gateway/mail-health`); with no
  Gmail, or only Gmails connected before every connect asked to send
  (`readOnly`, see [calendar-writes](../communications/calendar-writes.md)),
  the turn's prompt asks the model to offer the link once, after answering
  what was asked (`apps/mcp/src/agent/googleOffer.js`). An answer in the
  recent chat that already offered it keeps it away, so it is not said on
  every text; mailboxes that cannot be read are never news.
- **The two screens, said and shown.** Google has not verified Context, so it
  warns first, and its permissions page lets a box be left unticked, which
  leaves Tex unable to do that part. `connect_google`'s result and the ready
  text both say: tap Advanced, then Go to Context (unsafe), then tick Select
  all and Continue. Both send a picture of the two screens, drawn rather than
  screenshotted and labelled as a guide, served by the router at
  `/og/google-connect.png` beside the app the link opens
  (`infra/router/og-google-connect.source.html`, rendered by
  `scripts/render-og-card.mjs google`).

Tests: `apps/mcp/test/googleOffer.test.mjs`,
`apps/mcp/test/agentInstructions.test.mjs` (a texted turn with no Gmail is
asked to offer it), `apps/mcp/test/workspaceSetup.test.mjs` (the link's steps
and picture), `apps/agent/src/ready.test.ts` (the ready text's guide and
picture), `infra/router/src/texHost.test.ts` (the picture is served) and
`apps/convex/__tests__/mailHealth.test.ts` (`readOnly`).
