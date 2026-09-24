# Desktop — level meter and band

### The level meter had a subscriber, a normaliser, a fake and no producer

`onLevel` has been on the bridge since version 1. `packages/desktop-bridge`
declares `AudioLevel`, `BRIDGE_CHANNELS.level` names a channel, the preload's
`levelFrom` normalises the payload, `core/shell/bridge.ts` subscribes,
`fake.ts` emits one for the suite, and `test/consoleBridge.test.mjs` counted
its listener. **Nothing in the main process had ever sent one.** The console
drew five bars of fixed height and `Waveform.tsx` said so in as many words —
*"the heights are fixed and it does not animate"* — with three good arguments
for it, one of which was that nothing was listening.

The cost was not cosmetic, and it is the reason this is a decision rather than
a fix. **The meter is the only feedback that exists while a recording is
happening**: frames, segments and the note all arrive after the meeting is
over, so somebody recording a conversation they cannot repeat has nothing else
to look at. The owner spent an evening concluding his microphone was dead —
*"the bar is still not moving. And I can't tell that it can hear me talking."*
He was reading the control correctly. It looked **identical** whether the
microphone was live, denied, or nothing was running at all.

**A decoration in the shape of a meter is a capability claim too.** That is the
sentence `Waveform.tsx` had inverted: it argued that a moving bar would be a
claim, and did not notice that a bar which cannot move is the same claim with
no way to check it. This is the repo's own rule about invented facts, applied
to a shape rather than to a word.

Four decisions, and the third is the one that generalises.

**The producer is an `AnalyserNode` in the window that already holds the
stream.** `renderer/capture.ts` taps each open channel, posts a normalised pair
on `context:capture-level`, and `main/capture.ts` forwards it to
`consoleBridge.emitLevel`. Never connected to a destination — that would put
the meeting through the speakers — and **every step is wrapped**: a runtime with
no `AudioContext`, a stream the graph refuses, an analyser that throws, each
costs the meter and nothing else. A recording may never fail for a decoration.

**100ms, not a frame.** This runs for the whole of every meeting in a hidden
window with `backgroundThrottling: false` deliberately set, so nothing else is
going to impose restraint. Ten readings a second is what a person perceives as
responsive; `requestAnimationFrame` would be six times the analyser reads and
six times the IPC, 216,000 messages an hour, for a difference nobody can see. A
quantised pair unchanged since the last post is not sent at all, so a silent
room costs one message a second rather than ten — and the heartbeat is what
stops that becoming silence for a console window opened mid-meeting.

**The wire carries two channels and the glass draws one.** `AudioLevel` is
`{ mic, systemAudio }` because the shell genuinely knows both. Two meters would
be read wrong in both directions: on an unsigned build there is no loopback tap
at all, so the second bar would sit flat for a whole meeting and reintroduce
exactly the misreading this change removes; on a signed one it sits flat
whenever nobody else is talking. So the glass draws the louder of the two,
which is the honest answer to *"is this hearing anything"*, and the split stays
on the wire for a diagnostics screen that does not exist yet.

**Three states, and two of them are flat.** *Nothing listening* is a flat muted
baseline and that is **correct**; *listening in a quiet room* is a flat row two
and a half times taller in the live tone; *hearing a voice* is the silhouette
scaled by the level. A meter that has to animate to say "I am on" says nothing
in a silent room, which is where somebody recording alone spends most of a
meeting — so the first two are told apart by height and tone rather than by
motion. A fourth case is an absence rather than a state: `level === null` is a
phone, a browser, or a shell older than this, and it draws the static mark it
always did. Reading that as `0` would be the invented fact one layer down.

**The re-render argument survived intact and is answered by placement.**
`LiveMeetingScreen`'s whole promise is that nothing moves while you type, so
the subscription lives in `LiveWaveform` — a leaf — and a level ten times a
second re-renders that component and nothing above it. It is not on
`MeetingRecorder` either: four of the five recorders cannot produce one, and
the controller's `onChange` rebuilds the app's whole meetings snapshot.

**The check that would have caught this, and the class of defect it names.**
A member with no producer is a guard nobody checked, one layer out. So
`test/consoleBridge.test.mjs` now drives *every* producer the `ConsoleBridge`
object exposes and asserts that **every name in `BRIDGE_CHANNELS` is either
answered by a handler or actually sent** — nothing enumerated by hand but the
arguments, and a producer the census cannot drive reddens on its own line
rather than quietly not being driven. A second half asserts that `main/index.ts`
really calls each one, because `emitSegment` existing is not the same fact as
the shell reaching it. **The test that fails if this is reversed**: delete the
`send(BRIDGE_CHANNELS.level, …)` inside `emitLevel` and `EVERY CHANNEL IN
BRIDGE_CHANNELS HAS A PRODUCER IN consoleBridge.ts` names `context:on-level` in
its own failure line; delete the wiring in `main/index.ts` instead and the
second half reddens with the first still green.

**What no test in this repository can confirm**: that the bar moves. That needs
a signed build, a granted microphone and somebody to speak into it. The suite
proves the level is produced, clamped, carried across both halves of the bridge
and drawn at three distinguishable heights; the hardware walk is a person's.

### What is deliberately not built

Not built, and none of them foreclosed:

- **Windows and Linux shells.** `src/platform/macos/` implements four functions
  and a port implements the same four; the bridge, the outbox and the UI are
  already platform-free. What does not port is `audio: "loopback"`, which is a
  ScreenCaptureKit binding — a Windows shell would need WASAPI loopback and a
  Linux one has no general answer, so `capabilities().systemAudio` is false
  there and the UI already knows what to do with that.
- **A second bridge for the phone.** iOS has no shell and needs none: the Expo
  binary *is* the native surface, and `capture/audio.ts` already talks to
  `expo-audio` directly. `window.desktop` is a web-only concept by construction.
- **Running the console in an iframe.** Every guard above assumes the bridge is
  in a top frame, and an iframe would make "which origin is this" a question with
  more than one answer.
- **Deep-linking the shell from the web.** A `context://` scheme handler that
  focuses the shell from a browser tab is obvious and small and is not needed
  until somebody has two of them open.

### The console reserves the space, the shell places the buttons

Found by the owner on the installed app, and it is the plainest kind of defect
this section has recorded: `createConsoleWindow` sets `titleBarStyle:
"hiddenInset"`, which keeps the traffic lights but removes the bar that used to
hold them clear of the page — and the hosted console draws its own chrome from
`x: 0`, with nothing telling it that the top-left corner of its own window is
spoken for. The close, minimise and zoom buttons sat on top of the active-context
chip, because nothing in this app had ever been told they were there.

The orchestrator's decision, 2026-09-07, and it is a split rather than a single
fix: **the page reserves the space; the shell places the buttons in it.** A
38px band, full width, in the console header's own colour, drawn only when the
page is running inside the shell on macOS — and marked
`-webkit-app-region: drag`, so the window can still be moved by a click there
now that there is no title bar to grab. The shell's own half —
`trafficLightPosition: { x: 12, y: 12 }` on the `BrowserWindow` — is a separate
change to `apps/desktop`, on its own branch: this repository does not gate one
half of a two-process fix on the other landing first, and a page that already
reserves the pixels degrades to "an empty 38px strip with nothing drawn on it"
against a shell that has not shipped the other half yet, rather than to the
defect this section describes.

**Neither side may own both numbers, and that is why they live in
`packages/desktop-bridge` rather than in either app.** `SHELL_TITLE_BAND_PX`
and `SHELL_TRAFFIC_LIGHTS` are compiled into both bundles from one file
(`src/layout.ts`) — not asked for at runtime, and not a `BRIDGE_VERSION`
change, because neither is part of `DesktopBridge`: the page never asks the
shell "how tall is your band", it is simply built to the same constant the
shell is. The tempting shortcut — hard-code `38` in `ShellTitleBand.tsx` and
`{ x: 12, y: 12 }` in `windows.ts`, because "it's one number, we'll remember" —
is the shape every other drift in this file was found the same way: two
sessions, two PRs, one of them changes its number and the other does not, and
the defect this section exists to fix comes back on the next release with no
diff that looks wrong on its own.

**Detection is the same rule as everywhere else in this file, not a new one.**
`Platform.OS === "web" && getDesktopBridge()?.shell?.platform === "macos"` —
stated as a pure function, `shouldShowShellTitleBand` in
`apps/mobile/features/app/shellTitleBand.ts`, for the reason
`app/(app)/console/_layout.tsx` already gives about `files/scope.ts`: *"in a
sabotage sweep of this codebase, every guard written as a pure module held and
every guard written inside a component did not."* No band on a phone, none in
an ordinary browser tab, none on a shell this bundle cannot identify as macOS —
`docs/decisions/desktop.md`'s existing rule that "macos is the only one built"
means a Windows or Linux shell gets no band today, on the same honesty
`capabilitiesFrom` already applies to every other unasked-for feature: nothing
is claimed for a platform nobody has verified it against.

**The band is mounted once, above every route, in `app/_layout.tsx` — not in
`(app)/console/_layout.tsx` alone.** The defect names the console, but the
shell hosts the sign-in screen before there is a session too, and a person who
never gets that far would meet the same buttons over the same corner on
`/login`. Mounting it above the route groups, inside the ground `View` every
screen already renders into, is what makes it "appear identically on the
sign-in page and the console" a property of where it is mounted rather than a
promise kept by hand on two screens that happen to agree today. It survives the
offline mirror for the same reason the rest of this file's mirror sections
argue: `apps/desktop/src/main/consoleMirror.ts` serves a saved copy of this
exact web bundle from `app://console/`, so a component mounted in the root
layout is in the mirror because it was in the build, not because anyone
remembered to mirror it separately.

**It reserves space; it does not float over content.** In normal document
flow — not `position: "absolute"` — so it pushes the route below it down
rather than layering above it. That is also the whole of "must not eat clicks
meant for content": there is nothing under an element that occupies its own
row for a stray press to land on instead. The band itself draws nothing
interactive today, so nothing on it needs
`-webkit-app-region: no-drag` yet; the day a control is added to it, that
control must set it, or a click meant to activate it will drag the window
instead — recorded here rather than only in the component's own comment,
because it is the one rule about this band that a future change is most likely
to need and least likely to think to look for.

The tests are `apps/mobile/__tests__/shellTitleBand.test.ts` (a Mac shell shows
the band; a Windows or Linux shell does not; no shell at all does not; native
platforms never ask) and `packages/desktop-bridge/test/layout.test.mjs` (the
two constants, and that `SHELL_TRAFFIC_LIGHTS` is frozen so one side editing its
own copy cannot silently stop matching the other's). The shell's half —
drawing the buttons at `SHELL_TRAFFIC_LIGHTS` — is not tested here because it
is not built here; it belongs to the `apps/desktop` change this section
anticipates rather than ships.

### The band's other two payers, and the shell half finally wired

The band above shipped and two surfaces went on ignoring it, which the owner
reported from the installed app in one sentence each: *"the bottom part looks
cut off"*, and *"some pages dont take the streetlights in consideration"*, with
a screenshot of the settings bar's *Notes* control under the traffic lights.
Both are the same omission — a reservation drawn above every route only moves
things that are laid out *by* that route tree.

**The app frame is one viewport minus the band.** `AppFrame` is sized in
viewport units and not by a flex parent (`design/css.ts` argues `100dvh` over
`100vh`, and that argument is untouched), so a band drawn above it does not
shorten it: the frame stayed a full window tall and hung `SHELL_TITLE_BAND_PX`
past the bottom, taking the context switcher and the sync row off the bottom
edge with nothing to scroll. `viewportHeight()` now takes the inset something
above it already spent, `calc(100dvh - 38px)`, and the unit stays dynamic
because the subtraction is the constant, not the viewport. **The test that
fails if this is reversed**: `shellTitleBand.test.ts`'s `"THE FRAME IS ONE
VIEWPORT MINUS THE BAND"`, asserted against the style function rather than a
node, because jsdom drops any declaration containing `dvh`.

**A `Modal` is its own root, so settings reserves the band itself.** `Overlay`
is deliberately a `Modal` — its header keeps it for the focus trap on iOS and
Android — and nothing in the route tree, band included, is above it. It
therefore renders `ShellTitleBand` as its own first row, in its own `ground`
rather than the console header's `surface2`, and reserves the space with the
band element rather than a `paddingTop` so the drag region comes with it: while
settings is open, the top edge of the window is still where a person grabs it.
Any future full-window `Modal` owes the same, and the reason it is written here
as well as in the component is that this is the second time this exact
reservation was missed by the second surface to need it.

**And the shell's half, which the section above anticipated and left unbuilt,
is wired**: `createConsoleWindow` passes `trafficLightPosition:
SHELL_TRAFFIC_LIGHTS`. Until it did, the page reserved a number from
`packages/desktop-bridge` and the shell placed the buttons wherever macOS
defaults put them for `hiddenInset` — the two agreeing by luck, which is the
drift the shared constants exist to prevent. The notepad window deliberately
does not get it: it loads `notepad.html` from disk, not the hosted app, so
nothing there reserves the band the position assumes.

**Still not done, and deliberately not smuggled into this change**: the band is
an empty strip *above* the console's own top bar, where a Mac app people
compare this to puts the traffic lights *in* that bar. Unifying them is not a
number — it needs the route to declare that its own chrome reserves the lights
(the frame would pad its leading edge instead, and the root band would stand
down for it, the way `bottomChrome.ts` already lets the frame publish a height
upward), and it needs every interactive child of that bar to carry
`-webkit-app-region: no-drag` or a click on it moves the window. That is a
layout change across every density with its own diff and its own screenshots.
It is the section below.

### The band moves into the bar

Reported by the owner against the shipped shell, in the plainest terms the
defect has: *"why is the top forehead so big, this needs to be more compact and
thin like notion"*. Measured, it is 45pt of band drawing nothing on top of a
45pt top bar, and the explorer's own 44pt header under that — 134pt before the
first note, in a window whose default height is 760.

**The comparison is more instructive than the complaint.** Notion's chrome is
*taller* than this app's was: a tab strip of about 40pt and a page toolbar of
about 45 under it. It reads thinner because both of its rows do a job — the
window controls sit *in* the tab strip. The number to cut was never the total;
it was the row that draws nothing, and there was exactly one.

**The console's own top bar takes the buttons, and the root band stands down
for it.** The bar keeps `layout.topBarHeight` and pays
`SHELL_TITLE_BAND_LEAD_PX` of leading inset instead — 84, which is not a new
measurement but the one `apps/desktop/src/renderer/notepad.css` has run its own
45pt bar at since it was written. What the window gets back is the band's
whole height, and what that buys, at the default window size, is two more rows
of the note list.

**It is a handshake, not a constant, and that is the whole of the design.**
Three surfaces inside this same shell have no bar that can hold anything:

- **The sign-in group.** No frame at all — the shell hosts it before there is a
  session, which is why the band was mounted above every route rather than in
  the console's layout in the first place.
- **Settings.** `Overlay` is a `Modal`, its own root view, with the console
  frame still mounted *behind* it and still saying it holds the buttons. This
  is the surface that makes the handshake a two-component split rather than one
  component with an `if`: `ShellTitleBand` is unconditional and settings uses
  it; `RootShellTitleBand` reads the flag and only `app/_layout.tsx` uses it.
  An overlay that consulted the flag would put the buttons back over its own
  *Notes* control — the exact defect the section above records fixing.
- **Compact density.** `topBarCompact` is `position: "absolute"`, transparent,
  and lying over a document that scrolls under it; buttons placed there would
  sit on the note. **A console window narrowed past `narrowBreakpoint` is that
  layout on a Mac**, so this is reachable by dragging an edge and not only by
  owning a phone — which is why the flag is published on every render of the
  frame rather than once on mount, and why widening the window has to take the
  job back.

So a frame publishes "I hold them" through `features/app/topChrome.ts` — the
same module-store shape, and the same argument for it, as `bottomChrome.ts` at
the other edge: the band is an *ancestor*, so it cannot read a provider the
route renders below it. **A layout effect rather than `useEffect`**, because
standing an ancestor down is a parent re-render driven from a child: React
flushes layout effects and the renders they schedule before the browser paints,
and with `useEffect` every cold load would show 90pt of chrome for one frame
and collapse to 45 on the next. That flash is the defect, briefly, every time.

**The flag may only ever take a band away, never put one there.**
`shellBandDraws` asks the platform gate first and the flag second. A frame
publishing "I hold them" is stating an opinion about a shell it may not be
inside, and the reverse order would grow 45pt of nothing on Windows, on Linux,
and in every ordinary browser tab the moment a frame unmounted. The test is
named for it.

**`SHELL_TITLE_BAND_PX` is now 45 because `layout.topBarHeight` is**, and that
equality is load-bearing rather than tidy. `trafficLightPosition` is set once,
when the window is created; the page's density goes on changing under it. Two
boxes of different heights could not share one `y`, so either the shell learns
to move the buttons at runtime — a bridge call, a `BRIDGE_VERSION`, a round
trip on every resize — or the two boxes are the same height and the question
never arises. `SHELL_TRAFFIC_LIGHTS.y` moved 12 → 16 to centre a button in it.
The band cost seven points on the two surfaces that draw nothing in it either
way, and bought a single position that is correct wherever the buttons land.
`shellTitleBand.test.ts` asserts the equality from the app's side and
`packages/desktop-bridge/test/layout.test.mjs` from the package's.

**`no-drag` goes on the frame's own slots, never on the controls a route hands
in.** The bar is the window's drag handle now, so a control inside it would
move the window instead of activating — the rule the section above flagged and
the reason this was not smuggled into it. A route can put anything in
`switcher`, `tabs`, `topTrailing`, `accountSlot` or `syncSlot`; a guard written
on those contents would hold for exactly the chips somebody remembered, and the
next one added would drag the window with no diff that looks wrong on its own.
On the slot it is structural. What stays grabbable is the bar's own background:
the gaps between slots, the run between the chip and the tabs, and the air
above the tabs, which hang from the bar's foot — so **the top edge of the
window is still where a person grabs it**, which is the property the settings
overlay was already keeping and the console now owes too.

The tests are `apps/mobile/__tests__/topChrome.test.ts` (the store, and which
densities may take the job), the new half of
`apps/mobile/__tests__/shellTitleBand.test.ts` (both pure rules, the two
components giving different answers to the same flag, and settings keeping its
band while the console behind it holds the lights), and the new half of
`apps/mobile/__tests__/appFrameRender.test.ts` (the bar in real DOM: the lead,
the drag region, every filled slot opting out, and the job handed back on
narrowing and on unmount). **One thing here is not covered and is worth saying
so**: that the effect is a *layout* effect rather than an ordinary one is
invisible to jsdom, which paints nothing — `act` flushes both the same way. The
argument for it is above; the check is a cold load on a Mac.
