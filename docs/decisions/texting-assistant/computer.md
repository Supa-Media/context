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

## A PDF on the web is read like a file (2026-10-20)

A browser shows a PDF as a viewer with no text, so a race's course map texted
as a link reached Tex as nothing ("I can't show the map", 2026-10-17), and so
would any invoice, menu or form that is a PDF. The screenshot Worker's fast
path now hands a PDF of up to 10 MB on whole (`fetchText.ts`, `via: "file"`),
and the gateway reads it as `read_file` does, its words through `fileWords`
and its links through `pdfLinks`, which become links the turn may follow
(`pdfPage`, `browserProviders.js`). The bytes never reach the model. Tests:
`fetchText.test.ts` ("a PDF at the address"), `test/pdfPage.test.mjs`.

## A page a site refuses us is asked for through Browserbase (2026-10-22)

Many sites answer a request from a Cloudflare address with 403, 429, 503 or
a challenge, and Cloudflare's browser comes from the same addresses, so such a
page cost a browser start and still failed. When the plain request is turned
away (`fetchRead` says `refused`), `/read` asks once more through Browserbase's
Fetch API (`browserbaseFetch.ts`): one proxied request from Browserbase's
network, no browser, a second or two. It is shaped as a `fetch`, so the same
code reads its answer: Browserbase is told never to follow a redirect
(`allowRedirects: false`), and each hop is followed by hand under the same
public-https lock. Only HTML and Markdown come through, because a PDF arrives
as text and would be mangled. Only the address is sent, as with every page
Browserbase opens for us. A page that answers but draws itself with
JavaScript is not refused, and goes straight to the browser as before.
Browserbase browsers also start with `blockAds: true`, its own ad and tracker
blocker, so a cluttered page loads faster and reads in fewer steps; no
extension is uploaded. Tests: `browserbaseFetch.test.ts`, `fetchText.test.ts`
("says when the site turned the request away…").

An action called on the wrong one of the six (`write { action: "progress" }`,
seen twice) runs under the family that has it, with that family's grants,
instead of failing (`sixTools.js`; "an action called on the wrong one of the
six runs where it lives, never wider").

A texted turn is told where Google lands in its notes (`SYNCED_PLACES_LINE`,
`prompt.js`): one calendar note a day under `0-inbox/calendar/`, and email
under `0-inbox/email/<account>/`. On 2026-10-18 Tex said "I can't read your
Google Calendar" with every day of it there, and filled the gap with dates
from someone else's test notes. Test: `agentSyncedPlaces.test.mjs`.

## Tex attaches the person's own files to a page (2026-10-20)

An upload button opens the device's file picker, which a remote browser has no
way to answer, so Tex told Dev it couldn't attach a receipt to a reimbursement
form (2026-10-20). A browse step `upload` now puts one file into the page's
upload box: the file input the step names, the one inside or beside it, or a
drop on it when the page only takes drops (`uploadSource`, `browse.ts`).

Tex has no drive of its own. The file is one of the person's, found the way
they would find it (`uploads.js`): a file in their notes, read only after
`read_file` as the person lets them see it, so a held-back file is "not found"
and its bytes are never fetched; an email's attachment; a picture they texted;
or, when the thing to send is the email itself (a confirmation, a receipt), that
email printed to a plain PDF (`textPdf.js`). The bytes go from the bucket to
the browser and never reach the model.

Off the open web a file goes only to a site the person named in their message,
and the browser re-checks the host at the moment of upload (`onlyOn`), the same
rule as typing. Tests: `test/agentUploads.test.mjs` (sabotaged: skipping the
`read_file` gate, dropping `onlyOn`) and `browse.test.ts` ("puts the person's
file into the page…", "uploads nothing on a site the person did not name").
The input and drop paths were checked in real Chromium by hand.

The first real try (2026-10-20) found the common case the step missed: an app
that makes its file box only when its button is pressed (`expo-document-picker`
on the web creates an input and calls its `click()`), so the page had no box
to fill and pressing the button opened a picker on the remote machine nobody
could see. Both steps now press with a stand-in picker in place
(`pickerHookSource`): a file box the page opens, by `click()`, `showPicker()`
or a label, gets the person's file on an upload step and is only noted on a
click, which then says an upload step naming the same element attaches one.
This is done in the page rather than with Browserbase's uploads API and CDP
`DOM.setFileInputFiles`, so the file never sits on the browser's disk and the
same code runs on both providers. Tests: `browse.test.ts` ("presses a button
that makes its file box only when pressed…", sabotaged by skipping the press),
plus an app-style button, a label and a plain button checked in real Chromium.

## Tex downloads a file and emails it (2026-10-22)

Tex found a Google Voice invoice on the Admin console's billing page and texted
the owner "I can't put a file from the admin console into an email myself. Tap
the download arrow next to September, attach it to the draft". The owner: "it
should be able to download a pdf and email it, if not we are severely lacking
in capability". Browserbase had kept every download all along; nothing asked
for them.

- **The step.** A browse step `download` presses the element that saves a file
  (by number or by its words), or with neither takes the file the page itself
  is (`infra/site-shots/src/download.ts`). On Browserbase the browser is told
  to allow downloads into `downloads`, the only folder its storage syncs
  (`Browser.setDownloadBehavior`), and the file is taken from its Downloads
  API by session (`GET /v1/downloads?sessionId=`, then the file), then
  deleted there, so nothing of the person's stays with the vendor. When no
  file arrives in 8 seconds, and on Cloudflare's browser, the link's address
  is fetched in the page with its cookies: https, `blob:` or `data:` only, and
  never a web page passed off as a file. 10 MB at most, as a file is read at.
- **Where it is kept.** In the person's own bucket, `.context/agent/downloads/<id>.json`,
  under a random `download:` id that carries when it was kept (`agent/downloads.js`).
  The owner, the same day: "store it in a hidden folder in the bucket just so
  that it persists across Tex sessions". Up to 5 MB it stays 30 days; up to
  10 MB, 24 hours, enough for an email waiting on a yes. Expired files are
  refused by id and swept on the next download. Not a note: it is a working
  file, and the bucket is the tenancy boundary, so an id names nothing in
  another person's.
- **Into an email.** `send_email` and `save_email_draft` take `attach`, a list
  of up to five `download:` ids (`tools/emailAttach.js`); the person's copy
  names each file before their yes (`emailGate.js`), and the bytes go to the
  control plane once, to be sent, beside or after a forward's own files
  (`gatewayRoutes/personEmail.ts`). An email that says "attached" with a file
  attached is no longer refused as receipt-less. An upload step takes a
  `download:` id too, so a file can go from one site to another.
- **Tex sees the words, not the bytes.** A downloaded PDF's words come back
  with the id, marked as the site's, so Tex can check it took the right
  invoice before emailing it.
- **Handing it back is caught.** "I can't put a file … into an email" and
  "tap the download arrow … attach it to the draft" are hand-backs
  (`claimCheck.js` `FILE_HANDBACK`), even with a "tap" in them.

Tests: `download.test.ts` (the step, the vendor's API, the https-only fetch,
sabotaged by letting any address through), `agentDownloads.test.mjs` (kept,
expired, attached, named at the gate; sabotage record in the file),
`personEmail.test.ts` (files as real attachments, in a reply's thread, after a
forward's), `agentHandback.test.mjs`, and golden task 14 on a scripted billing
page (`must download:`, `must attach:`).
