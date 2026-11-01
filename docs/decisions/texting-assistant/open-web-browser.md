# The texting assistant — open web lifts the browser's limits

_Part of [the texting assistant](../texting-assistant.md), after "The agent
can click and type, and types only what the person vouched for"._

### Open web lifts the browser's capability limits (2026-10-14)

Decided by the owner, 2026-10-14: "let's remove the safety guards for
browsers. That's just not needed, not yet at least. Let's get all the
capabilities and then we'll rein it back because we don't have the users right
now to worry about it." With `open_web: yes` in the production setup
(`apps/mcp/src/agent/trustedSites.js`):

- **Any words may be typed on any page** — the person's, a note's, anything —
  and the gateway sends no `onlyOn`, so the browser does not re-check the
  page's host at the keys (`apps/mcp/src/agent/browse.js`).
- **A question may take 400 browser steps** (`MAX_STEPS_PER_TURN_OPEN_WEB`;
  the turn's own rounds bind first) **and open 40 pages**
  (`MAX_PAGES_PER_TURN_OPEN_WEB` in `computer.js`), shared by `open_page` and
  `browse`. Still 10 steps a call.
- **The `open_page` and `browse` descriptions drop the address and typing
  rules**, so the model does not refuse what it may now do.

This **knowingly reopens the exfiltration by typing** that the typing rule
closes, as open web (2026-10-11) already did for addresses: a page can ask the
assistant to type the person's notes into a box. It is lifted only under
`open_web: yes`. With it unset — every self-hosted gateway — the address guard,
the typing rule, the host re-check, 40 steps and 5 pages hold unchanged.

What it never lifts, because they are not capability limits:

- the vault's fill step is the gateway's and never a step the model writes; a
  secret is typed only on its entry's exact origin, into the matching kind of
  box, and never shown (`fillLogin.js`, `infra/site-shots/src/browse.ts`);
- `context.lc/vault` pages stay off limits to the browser (`offLimits`);
- private, IP, internal, non-https, port and credential addresses are refused
  by the gateway (`onOpenWeb`) and by `infra/site-shots` (`publicHttpsUrl`);
- a turn that read a page is still marked untrusted, which keeps Tex from
  vouching for a delegated message ([agent-egress](../privacy-and-sharing/agent-egress.md)).
  It no longer holds a widening: the owner removed that gate on 2026-10-17.

Reining it back is deleting the `open_web` line from the setup note, with no
deploy.

**What a simplification would cost:** dropping the `open_web` condition would
take the typing rule away from every self-hoster too; keeping the rule under
open web would leave the owner's decision undone. The tests that fail are in
`apps/mcp/test/agentOpenWebBrowse.test.mjs` ("with open web, note words may be
typed on a site the person never named, with no site limit" and "without open
web, note words cannot be typed on a site the person never named").

### Passkeys are off in Tex's browser (2026-10-29)

Google asked for a passkey on sign-in in a tester's chat. Chrome answered the
page's request with its own passkey window, which is browser furniture: it is
in no picture of the page, yet it holds the tab, so "Try another way" could
not be pressed by Tex or by the person who took the browser over. A passkey
lives on the person's own devices, and a request from this browser never
reaches them, so the request is never worth making there.

- Every page the Browserbase browser opens is told there are no passkeys
  (`infra/site-shots/src/passkeys.ts`): a passkey `get` or `create` fails at
  once with `NotAllowedError`, the way a person's cancel does, and the
  platform-authenticator checks answer false. Google then offers its other
  ways (password, a code). A password credential request is untouched.
- It is registered on every attach (`cdp.ts` `attachPage`), for `/browse`
  and the person's view alike, because a script added through one DevTools
  connection lasts only as long as that connection.
- A Google passkey step that was already showing before the script ran is
  loaded again once, which closes Chrome's window; a page that already had
  passkeys off is never reloaded, so the step cannot loop.

**What a simplification would cost:** registering the script only for
`/browse` would leave the takeover view pressing a page under an invisible
window; reloading every passkey step on attach would reload a page Tex is in
the middle of. The tests that fail are in
`infra/site-shots/src/passkeys.test.ts` and the jar test in
`browserbase.test.ts` that expects the passkey script first.

### The browser presses past Google's passkey step (2026-11-01)

With passkeys off, a job signing in to a site with "Continue with Google"
still stopped on Google's passkey step and texted that there was "no other
route". The browser was already signed in to Google; this was Google checking
it was really them before handing the site their account. The logs showed
passkeys off on every step and no typing at all: nothing says "Try another
way" was ever pressed.

- After the steps (never while the person holds the browser), site-shots
  presses "Try another way" on Google's passkey step and, on the list that
  follows, "Enter your password" when it is there, then reads the page again
  (`infra/site-shots/src/googleChallenge.ts`). With no password way, the list
  is left for Tex: a code, or Google's "tap Yes" prompt, which reaches the
  person's phone as a passkey request from this browser cannot.
- It logs `site_shots_google_step`: the step Google stopped on and the kinds
  of way it listed, never an option's words (they carry the end of a phone
  number).
- The gateway marks a browse result that met the passkey wall or reached
  Google's other ways (`pageWalls.js` `passkeyMarks`), and an answer that
  stops at a passkey on a turn that never reached them gets one more round
  (`browserWalls.js`). Google's list gets its own reading line.

**What a simplification would cost:** leaving it to the model's reading line
is what failed twice. Pressing on any site's passkey page would press on pages
we have never seen; this is Google's sign-in only. The tests that fail are in
`infra/site-shots/src/googleChallenge.test.ts`, the route test in
`browserbase.test.ts`, and `apps/mcp/test/agentPasskeyWays.test.mjs`.
