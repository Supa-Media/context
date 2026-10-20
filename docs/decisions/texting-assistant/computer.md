# The texting assistant — Tex's computer

_Part of [the texting assistant](../texting-assistant.md), after "The agent
can click and type, and types only what the person vouched for"._

### The person views and drives Tex's computer at context.lc/tex/<handle>

Decided by the owner, 2026-10-11, after connecting ChatGPT through Tex: the
handoff texted Browserbase's raw live-view URL, which is huge, cannot be typed
into on a phone, and drives the browser for whoever holds it. Instead:

- **One short, stable page per person**, `<APP_ORIGIN>/tex/<handle>`, the
  handle being the slug of the personal workspace they own. A handoff texts
  "Open this to take over the browser on chatgpt.com, then text me when
  you're done: https://context.lc/tex/seyi" (`texViewerUrl`,
  `apps/mcp/src/http/texComputer.js`). Browserbase's live-view link is never
  asked for (`infra/site-shots`), and a link the screenshot Worker sends is
  never taken for one to text. With no handle or no https `APP_ORIGIN` (a
  self-hosted gateway), the browser is not offered for handoff at all.
- **Only the signed-in owner sees it.** The app (`apps/mobile/app/tex/`)
  shows "not yours" for any other handle and asks nothing. Behind it, the
  gateway's `/tex/computer`, `/tex/computer/input` and `/tex/computer/stop`
  take the console grant (`context_console` only, as `/approvals` does: an
  MCP client holding the person's grant must not see or type into the pages
  they are signed in to), refuse a handle that is not the caller's own
  personal workspace, and make the browser tag from the user the token
  resolves to, never from the request. No new credential: the existing
  console grant is the signed-in person's proof to the gateway.
- **It only finds a browser.** The screenshot Worker's `/view/frame` and
  `/view/input` look up the session by the tag and never start one; nothing
  running is `{ running: false }`. The page polls about once a second while
  a browser runs and every five seconds otherwise, never in a hidden tab.
- **It is a remote desktop, not a page about one** (the owner, 2026-10-12,
  after trying the first version on his phone, with Chrome Remote Desktop
  as the reference). The picture fills the screen on a dark ground with
  pinch to zoom and pan; a cursor is drawn over it. In trackpad mode (the
  default) one finger moves the cursor and a tap clicks where it is; in
  touch mode a tap clicks where it lands. Two fingers dragged scroll the
  page under the cursor. The top bar is three icons (keyboard, mode, and a
  menu holding "Hand back to Tex" and "Stop browser"); a "Send text" bar
  sends text then Enter, and has Backspace and Return keys. Any touch takes
  control; there is no button for it. The geometry (`remoteView.ts`) and
  what a finger means (`remoteGesture.ts`) are pure and unit-tested.
- **Every action is bounded and whitelisted in the Worker** before anything
  reaches the browser: tap `{x, y, button}` (left only), move `{x, y}` (hover,
  no button), type, key (Tab, Enter, Backspace), scroll `{x, y, dx, dy}` (a
  wheel at the cursor) and back. The gateway rebuilds each from its named
  fields. What the person types goes to the page only: never logged,
  returned, put before the model or written to the bucket. "Hand back to
  Tex" tells them to text "done"; it does not text for them. "Stop browser"
  releases the browser.

**What a simplification would cost:** texting the vendor's live-view link
again hands a bearer link to the person's signed-in browser to anyone the
text is forwarded to; making the tag from the handle in the request, or
letting any client call the route, lets one person watch and drive
another's. The tests that fail are `apps/mcp/test/texComputer.test.mjs`
("bob's token never reaches alice's browser, whatever handle it names", "an
MCP client holding alice's grant is refused"), `apps/mcp/test/agentHandoff.test.mjs`
("the handoff text is short: their own /tex/<handle> page and the site, never
the browser's link") and `infra/site-shots/src/view.test.ts` ("finds a
browser and never starts one").

## A click a person could make, the page's code aside (2026-10-20)

Tex coded a Public Worship charge up to Chapter OS's category picker and
stopped: the picker's options were boxes with a click handler and no role, so
a reading numbered none of them, a click had to name a number, and the arrow
keys were not allowed. It handed the browser over and blamed the page. Dev:
"if a human can do it, tex should be able to do it as well".

So a reading also numbers the outermost box the hand cursor starts on (never
one wrapping something already numbered) and the ARIA roles a custom picker
uses; a click may name the words on the thing (`text`), or a point on a
`look`, which hands the model the page as a JPEG of what is on screen, in its
own pixels (the browser divides by the device pixel ratio). Press takes the
arrows and Space. Clicking stays unlimited, as above; a look is a page the
model reads like any other, so it carries no more trust than its words.

Tests: `infra/site-shots/src/browse.test.ts` ("clicks what shows the words it
names…", "looks at the page as a picture…") and `agentBrowse.test.mjs` ("a
look hands the model the page as a picture, with its size"). The hand-cursor
numbering needs a layout, so it was checked in real Chromium by hand.
