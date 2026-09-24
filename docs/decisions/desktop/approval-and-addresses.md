# Desktop — approval and addresses

### The approval happens in the app's own window, and that buys exactly one new address

The owner's decision, 2026-09-07: *"Keep the per-machine OAuth grant. Make the
approval happen inside the app window while the person is already signed in, so
it feels like one click."*

Both halves are load-bearing and the second is not a softening of the first. The
grant stays what *One meeting is one credential, and on a Mac it is the
machine's* made it: one OAuth client per machine, `context:write
context:private` and nothing wider, revocable on its own, minted through
`packages/hook`'s reviewed flow and stored in `safeStorage`. What moves is the
*window the approve screen is drawn in*, and only that.

**What it was.** `connect()` opened the system browser. The person then met a
console they were signed out of — the browser's cookie jar is not the shell's
`persist:console` partition — signed in a second time, approved, and was left
reading "you can close this tab" in an application that was not the one they
pressed Connect in. Three steps and two sign-ins for one grant, and the shell
put a modal in front of all of it explaining what the next screen was about to
explain properly.

**What it is.** The shell navigates its **own** console window to the same
authorize URL. That window is already at the console's origin, already holds the
session, and `/authorize?request_id=…` is an ordinary page load in it: the
control plane parks the request, renders its own approve screen, the person
presses Approve once, and the redirect lands on this machine's loopback
listener, which is the same listener the same flow has always used. Then the
window goes back to the console page they started from. The shell's own dialog
goes away in that case and stays for a tray-only launch, which has no window to
approve in and still opens a browser.

**Nothing in `apps/mobile` learned that it is inside the shell.** No bridge
member, no `getDesktopBridge()` branch on the consent screen, no shell-shaped
variant of the highest-value screen in the product. That is the measure of
whether this was the small change: the console is the console, and the shell
decides where it is shown.

#### What a simplification would cost

The simplification that offers itself is to notice that the person is signed in
to the console **in this very window** and conclude that a second credential
ceremony is theatre: let the page mint the grant, or send the console's session
to the gateway and have it issue one. That is the same trade *Sign-in stays in
the page, the grant stays in the main process* already refused, and doing it
here would cost:

- **The revocable machine.** A control-plane session is a *person*. A grant
  minted from it is not a laptop you can revoke on its own, which is the whole
  reason `connect.ts` registers one client per machine.
- **The window-less queue.** `drainOnce` runs with no page loaded and nobody
  signed in. A credential derived from a renderer's session is a credential that
  is gone when the page navigates — and this feature *navigates the page*.
- **The audit's honesty.** The gateway records the grant that acted. A session
  standing in for a machine makes every meeting this Mac files look like the
  person, from any device.
- **The pin.** Sending the console's session to the gateway means either
  widening what the pinned origin may talk to or putting a credential through
  the bridge, and both are refusals this file already spent a section on.

So the flow is untouched: PKCE with S256, dynamic registration, a **single-use
`state`**, the loopback listener on the port the OS handed out, the code
exchanged in the main process. The page holds a URL for as long as it takes to
navigate away from it, exactly as the browser held one.

#### Asking for the tier is not getting it, and the machine checks

Found reviewing this change rather than while writing it, and it is the reason
this section is longer than "the window moved". `DESKTOP_SCOPE` is
`context:write context:private`, and *One meeting is one credential* explains
the second half: the tier is not about reading here, it is what
`publishMeetingNote` **files a meeting as**. A grant without it makes the
gateway write the note team-visible and record that visibility in the
customer's own `privacy.md`, or refuse the write outright when the meetings
folder is private — a sentence about a destination, which is a true fact about
the wrong thing.

The consent screen defaulted the tier to `team` for every client. So the
shortest path through this whole feature — press Connect, read the approve
screen, press Approve — connected a Mac that filed every meeting its owner
recorded to everybody they share a folder with. Nothing lied, and nothing said
anything: the screen showed the tier as a control the person left where it was,
and the shell believed it had asked for private and got it.

Two halves, because either alone still fails:

- **The screen's default follows the request.** A client that names
  `context:private` opens on `private`; one that does not still opens on `team`,
  which is every silent client and most named ones.
  `docs/decisions/identity-and-access.md` carries the amendment and what it
  costs, because it reverses a word in a decision recorded there.
- **The machine verifies rather than assumes.** `connectMachine` records the
  scope the token endpoint returned **verbatim** — `tokens.scope ||
  DESKTOP_SCOPE` stood there, which made the record repeat the app's own
  request whenever a server answered without a `scope`, on the one field the
  check then reads — and `postEntry` refuses to send a meeting on a grant
  `grantCoversMeetings` does not accept. The meeting is held with its reason on
  the "This machine" card and in the outbox status, and it drains itself the
  moment the machine is reconnected at the tier the person meant.

Held rather than **parked**, and the distinction is deliberate: this reads
exactly like a park — a refusal retrying cannot fix — but nothing in this app
un-parks, so parking would mean a person who fixes the tier never sees the
meetings recorded before they noticed. It costs nothing to hold: the refusal
never reaches the network.

#### The one new address, and the three bounds on it

The approve screen ends by navigating to the client's redirect URI, and for a
native client that is `http://127.0.0.1:<port>/…`. The console window's
navigation guard refuses everything but the pinned origin and the offline
mirror, so that navigation has to be allowed — and it is allowed only:

1. **while a connect is in flight.** `createApprovalRoute()` in
   `core/shell/approval.ts` holds the address between `begin()` and `end()` and
   answers `null` at every other moment, so a page that walks to a loopback
   address on an ordinary afternoon is cancelled like any other off-origin
   target. `end()` runs in `connectThisMachine`'s `finally`, so a refused,
   failed or timed-out connect closes the allowance too.
2. **to the exact address this flow registered** — origin *and* path. Neither
   another port on this machine (something else is listening there) nor another
   path on ours is a target. The address is never typed: it is read out of the
   `redirect_uri` of the authorize URL the flow itself just built from its own
   listener, so the allowance cannot name a port the listener is not on.
3. **as loopback over `http`** — `127.0.0.1`, and deliberately not `localhost`,
   which is a name somebody else's DNS can answer. The authorize URL itself must
   be `https`, or loopback for a self-hoster's local gateway, which is
   `credentialUrlOk`'s rule applied to a navigation.

**And the rule is asked on both events that can move this window, which it was
not.** `will-navigate` reports what a *page* starts — a link, a form,
`location.assign`. A `Location:` header part way through a navigation that was
already allowed is `will-redirect`, and that one was unguarded, from before this
change: an open redirect on the pinned origin, or an authorize page answering
`302 Location: https://attacker.example/`, moved this preloaded window to a
foreign origin without the rule ever being consulted. It was pre-existing and it
is not theoretical *here*, because this feature deliberately walks the window to
an authorization server and back — console origin → loopback is exactly the
server-started chain `will-redirect` reports. Both events now call one
`mayNavigate`, so the pin cannot be enforced against one kind of navigation and
not the other, and the allowance above is the only widening either of them has.
The check is that both are wired to the same function, because the failure mode
is a third one added later that quietly does not ask.

**What that costs, named rather than discovered.** The gateway's
`/oauth/authorize` answers `302 Location:` the control plane's consent screen,
and that hop is now checked like any other: it is allowed because the consent
screen is `APP_ORIGIN` + `/authorize`, the same origin the console window is
pinned to — `CONTEXT_DESKTOP_UI_URL` defaults to `<that origin>/console` and the
two are routes of one Expo app. A self-hoster who deliberately split them onto
different origins would have the in-window approval refuse that redirect and end
at the listener's timeout with a message on the machine card, where before it
would have moved the pinned window to their other origin. That is the right
direction to fail in — a pin a server can move is not a pin — and it is written
here so the next person meets it as a decision rather than as a bug.

Two properties fall out and are worth stating because they read as omissions.
**While the window sits on the gateway's authorize page the pin is nothing**:
`pinnedOriginFor` answers `""` for an origin that is neither the console nor the
mirror, so the bridge refuses that frame on every channel — the approve screen
gets no more from this shell than any other page at an origin we did not pin.
And **the window is never left on the loopback listener's page**, whose socket
has closed by the time it renders: `returnAfterApproval` puts it back on the
console page the person pressed Connect on, narrowed through the same navigation
guard rather than trusted, and on the console's own address for anything else.

#### The tests that fail if either is loosened

`apps/desktop/test/approval.test.mjs`, and it is deliberately two kinds of check
in one file. The pure half drives the guard: the allowance is closed before
`begin()` and after `end()`, another port and another path are refused with a
connect in flight, `127.0.0.1.attacker.invalid` is not loopback, and a foreign
origin, a `file:` URL and an unparseable target are refused exactly as they were
before any of this existed. The other half runs the **whole** `connectMachine`
flow with an opener that behaves like the console window — it applies
`mayNavigateConsoleWindow` before following the redirect the approve screen would
follow — so the state check and the navigation rule are asserted *composed*: a
callback carrying a state this machine never minted is refused, nothing is
exchanged for it, and a replayed callback lands on a closed socket.

Sabotage, measured as FAIL lines across the desktop suite: comparing the
callback by host rather than by origin **2**; by origin without the path **1**;
`end()` not clearing the allowance **2**; the allowance open from construction
**1**; `approvalTargetFor` accepting a non-loopback `redirect_uri` **1** or an
`http` authorize URL off loopback **1**; `mayNavigateConsoleWindow` dropping
`isAllowedConsoleNavigation` **1**; `returnAfterApproval` trusting the URL the
window was on **2**; `windows.ts` reverted to the two-argument origin guard
**1**; dropping the `will-redirect` handler **1**; and `stateMatches` swapped for
`true` **5**. For the tier: `grantCoversMeetings` answering `true` **7**, or
`write || tier` instead of both **5**; `postEntry`'s check removed **5**; and
`scope: tokens.scope || DESKTOP_SCOPE` put back **1** — small because it is one
fact, and the fact is that the record must say what the *server* said.

`end()`'s row moved from 1 to 2 with the timeout check, which is the row that
was missing: the person who walks away from the approve screen is the ordinary
way this ends with no grant, and it is the only path where nothing arrives to
close the allowance. It is driven with a listener window of milliseconds — hence
`timeoutMs` on `ConnectOptions` — because a guard whose only test takes five
minutes is a guard nobody runs.

On the console's side, `apps/mobile/__tests__/desktopApproval.test.ts` holds what
the desktop flow leans on the page for — a session renders the approve screen
rather than a second sign-in, no session gets the console's own sign-in carrying
the request id, the loopback redirect is one the screen will hand the window back
to while cleartext anywhere else still is not, and the tier control opens on the
tier this machine asked for. Sabotage there, as failing tests across
`apps/mobile`: `defaultTierFor` back to always `team` **3**, and always
`private` **11** — the second is larger because defaulting private for a client
that asked for nothing is the older, wider bug.

### And then the approval stopped happening at all, which is the point

The owner, on the first end-to-end desktop capture, 2026-09-07: *"I don't love
this setup; when installing Granola I didn't have to 'connect' a machine, things
just worked."*

He was signed in **in the window the approve screen was drawn in**, and the app
still asked him to authorise the same person, on the same machine, to the same
context. The section above moved that screen out of a browser and called it "one
click"; a click is one more than zero, and zero is what a person who is already
signed in has actually consented to being asked for.

So the step goes and the grant stays. On first launch, once the console inside
the shell has a session, the shell obtains its machine grant from that session
automatically. Signed out, nothing is minted and the person meets the screen
above, which begins with the console's own sign-in.

**The shape, and it is a narrowing of the section above rather than an
addition.** The gateway's `/oauth/authorize` **parks** the request and answers
`302 Location:` the consent screen. So the shell follows that one hop itself —
in the main process, `redirect: "manual"`, no credential in the request and none
in the answer — reads `request_id` out of the `Location`, and hands **the page**
that id over the bridge. The page calls `approveOwnMachineGrant` with its own
session and navigates to the redirect it is given, which is this flow's own
loopback listener. The window is never sent to the authorization server at all:
this feature makes *fewer* off-console navigations than the approve screen did,
and the one it makes is the same one, bounded by the same
`createApprovalRoute()` allowance, to the same address.

#### The four things that did not move

- **The shell never receives the console's session**, and the page never
  receives the machine's PKCE verifier, its `state`, or anything the shell
  stores. What crosses the bridge is one request id out and `{requestId,
  approved}` back. The authorization code arrives at the loopback listener in
  the main process, where the verifier that redeems it lives — so *Nothing
  credential-shaped crosses the bridge* is unchanged, and is now the reason the
  page navigates rather than handing the shell a URL.
- **The grant is still the machine's.** `context:write context:private`, one
  client per machine (`Context on <hostname>`), in `safeStorage`, spent by a
  queue that drains with no window open. Every reason in *Sign-in stays in the
  page, the grant stays in the main process* still holds; what that section
  refused was the console's session **standing in for** the machine's grant, and
  nothing here does that.
- **The control plane decides.** `approveOwnMachineGrant` refuses a client that
  did not declare itself the shell, a redirect that is not loopback, a scope
  that is not exactly the default, and an approver whose role cannot grant the
  tier — and it is rate limited.
  `docs/decisions/identity-and-access.md`, *A first-party signed shell may have
  its own grant approved by the session hosting it*, is the argument and says
  what auto-approving any client would cost.
- **`grantCoversMeetings` and hold-not-park are untouched.** A machine that ends
  up without the tier still refuses to send, still holds the meeting with its
  reason on the card, and still drains itself when the grant is fixed.

#### Every refusal costs a screen, and never a grant

That is the property the whole design is arranged around, because it is what
makes a new failure mode impossible rather than unlikely. A page that is signed
out, a control plane that refuses, a `Location` at an origin this window is not
pinned to, a network that failed, a bundle older than bridge version 3, a window
serving the offline mirror, a page that answers nothing at all — every one of
them ends with `approveInConsoleWindow`, which is exactly what shipped in #312,
and then with the system browser for a tray-only launch. The page-that-answers-
nothing case is a four-second timeout in the shell rather than a hope: without
it, an old bundle would wait out the listener's five minutes on a console that
says "Connecting".

**A self-hoster who split the console and the consent screen onto different
origins** lands in that same fallback, deliberately. `parkedRequestFrom` reads
the id only from the origin the window is pinned to, because the session that
can answer it belongs to an origin — and the section above already chose this
direction when the pin refused a hop: *a pin a server can move is not a pin.*

**And it refuses the opaque origin by name, on both sides of that comparison.**
`new URL("data:/authorize?request_id=…").origin` is the *string* `"null"`, as is
a `file:` URL's, so two opaque origins compare equal to each other. The pin
cannot be opaque today — `consoleUrl` admits only `https` and loopback `http` —
but *Nothing that can start a recording may come from an origin we did not pin*
already refuses `"null"` by name in `shouldExposeBridge` for this exact reason,
and `parkedRequestFrom` was the one origin comparison in the shell that did not.

#### What `apps/mobile` learned, and the sentence that reverses

*"Nothing in `apps/mobile` learned that it is inside the shell"* was the measure
of #312 being the small change. This reverses it, and the reversal is bounded to
where it cannot become a second code path through the consent screen:

- the **consent screen is untouched** — no bridge member, no
  `getDesktopBridge()` branch, no shell-shaped variant. It is still what every
  other client, and every refusal here, goes through;
- what learned about the shell is **`ThisMachineCard`**, a component that only
  renders inside the shell in the first place, and the rule for when it may mint
  is a pure function (`features/meetings/machineApproval.ts`) rather than three
  `if`s in a component.

The card's line names the context the control plane resolved — "This machine can
write to @name" — because that slug is a fact the page has and the shell has
not: a `ConnectionRecord` holds a gateway base URL and never a name. Naming the
context the console merely happens to be *showing* would be a sentence about the
wrong thing on the one card whose job is saying where meetings go.

#### The tests that fail if any of it is loosened

`apps/desktop/test/autoGrant.test.mjs` drives the two pure pieces and then the
whole flow through `connectMachine` with a page-shaped opener, so what is
asserted is the app's own path: the window is never navigated to the
authorization server, the page is handed one request id and nothing else, and
the code comes back through `mayNavigateConsoleWindow` to this flow's own
listener. `apps/convex/__tests__/ownMachineGrant.test.ts` proves each refusal in
the control plane, including that somebody else's parked request grants *their*
context and never yours. `apps/mobile/__tests__/meetingsDesktop.test.ts` proves
the page mints once, tells the shell either way, and draws itself against a
version-2 shell without calling members it never promised.

Sabotage, measured as failing tests across each suite. Desktop:
`parkedRequestFrom` not comparing the origin **3**, not comparing the path
**1**, accepting any id shape **1**, answering for an empty console origin
**0**, not refusing the opaque origin by name **1**; `isParkingRedirect`
accepting a 200 **1**; `ApprovalHandover.take`
ignoring the id **2** or not clearing **1**; `endApproval` not closing the
handover **2**; the fallback chain reordered **1**. Convex:
`decideMachineApproval` answering `ok` unconditionally **12**, dropping the
software-id condition **2**, the loopback condition **3**, the scope condition
**5**, the tier condition **2**; `isLoopbackRedirect` accepting any hostname
**1** or `https` **1**; the mutation skipping `requireWorkspaceAccess` **1**,
its `pending` check **2**, its expiry check **1**; the rate limit removed **1**;
`arm` not writing `grantedScope` **13**. Mobile: `decideMachineApproval`
minting unconditionally **13**, ignoring `answered` **9**, `auth.isLoading`
**2**, an already-connected machine **2**; the card not telling the shell about
a refusal **1** or a success **2**; not navigating to the redirect **1**; the
refusal line naming what the control plane said **2**; the card seeding a
pending approval from `?request_id=` **2**.

**The mobile rows were measured as zero on the first attempt**, and the reason
is recorded in `meetingsDesktop.test.ts` rather than quietly fixed: the harness
read the suite's stdout and Jest writes its summary to stderr. A sabotage run
that cannot see a failure reports a guard that does not exist as a guard that
is not needed, which is the exact failure mode this whole practice exists to
avoid — so the number to distrust in any sabotage record is a zero that arrived
without an explanation beside it.

Two rows are worth reading twice. `arm` is the largest because both approvals
share that function, which is why it is one function — a refactor that stops
recording what was granted reddens the consent screen's tests as well. And the
desktop **0** is a real zero, kept rather than deleted: an empty console origin
already fails the origin comparison on the line below it, so that early return
cannot change an answer on its own. It stays because it names what the case
means and because it is what keeps that true if the comparison is rewritten;
`autoGrant.test.mjs` records the same row with the same reasoning.
