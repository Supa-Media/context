# The texting assistant — note links and how Tex asks

Split out of [texting-assistant.md](../texting-assistant.md) on 2026-10-18 when it grew past the review threshold.

### A texted write answers with the note's link, and an ask sounds like a person

Decided by the owner, 2026-10-18, while settling the landing page's sample
conversation. When a text makes Tex write a note, `write_note`'s result on
that turn carries `link: <APP_ORIGIN>/note/@<slug>/<path>`
(`apps/mcp/src/agent/noteLinks.js`), so Tex can text the person where it went,
under the rule that it only states a link it read in a tool result. The link
grants nothing: opening it is a sign-in and the console's own check, and it
unfurls as Context's card, never with the note's name. No https `APP_ORIGIN`,
no known context name or a failed write gives no link rather than a guessed
one.

The ask that ends a held call reads the way a person asks ("'Text YES to
send' seems very robotic"): "Look good? Just say yes and I'll send it." for
an email, a calendar change and a bug report, which still go only on a bare
yes, and "Should I go ahead?" for the rest (`agent/textedApprovals.js`).

### A texted read answers with it too, and an asked-for link is always given

Decided by the owner, 2026-10-20, after Tex summarised an SOP from a shared
workspace and then answered "Give me the link" with "I don't have a web link
for it". `read_note`'s result on a texted turn carries the same `link:` line,
in its header after `path:` and for whichever context the call named, shared
ones included. Every texted turn is told (`NOTE_LINK_LINE`, said whatever the
production setup says) to send that link after an answer taken from one note
when the whole note would help, to send it whenever asked, reading the note
first if need be, and to mint a share link only when they ask for one to send
to someone else. Undo by dropping `read_note` from `withNoteLinks`.

Tests: `apps/mcp/test/agentNoteLinks.test.mjs` (sabotage record in its
header), and the ask lines in `emailGate`, `calendarGate`, `reportGate` and
`agentEgressTexting`.

### A note link they text is the note, and its preview card is nobody's text

Owner's report, 2026-10-21 ("this was infuriating"). Dev pasted the link of
yesterday's meeting note after Tex said it had no notes from the call, and
Tex answered about the link's preview picture ("just a hashtag icon"), then
answered the picture again on its own ("That's the Context banner").

- A link of this deployment's own to a note, in either shape the app opens
  (`/note/@slug/<path>`, `/console/@slug?note=<path>`), is named to the turn
  as that note, to be read with `fetch` in that context (`sentNoteLinks`,
  `apps/mcp/src/agent/noteLinks.js`). It grants nothing: the read goes
  through the dispatcher and `canSee`, and another host's link, a path with
  `..` or a context with no `@` is not a note.
- On Sendblue, a file that comes with an address in the words, or a
  `.pluginPayloadAttachment`, is the link's preview and is dropped where it
  is read (`isLinkPreview`, `apps/agent/src/sendblue.ts`); a lone picture
  within 15 seconds of a texted link is the same card sent on by itself, and
  is dropped too (`LINK_PREVIEW_MS`, `apps/agent/src/inbox.ts`). Both log
  `sendblue_link_preview`, never the address.
- Every texted turn is told (`MEETINGS_LINE`, said whatever the setup says)
  to answer a question about a call from `fetch` "meetings:", which lists
  every recorded meeting newest first from every folder and workspace, to
  take a to-do's owner from the note's action items rather than a misheard
  transcript, and to offer to write something down at most once.

Tests: `apps/mcp/test/agentSentNoteLinks.test.mjs`, the preview cases in
`apps/agent/src/sendblue.test.ts` and `inbox.test.ts`, and the bench list
`apps/mcp/bench/ai/tests/meetings.md`.

### On Sendblue, every link goes with its picture, and never at either end of its text

Decided by the owner, 2026-11-03, after Sendblue support confirmed it attaches
no rich-link data, has no flag for it on `/api/send-group-message`, and has no
date for App Cards in groups. Every link Tex texted through Sendblue arrived as
a grey "Tap to Load Preview" box, a group's progress link and a source link
alike, and only Sendblue can attach a preview, because the device that sends a
text is the one that builds its preview. The owner asked for the fix as an
adapter, because Tex may move to another provider.

- On the Sendblue lines only (`line.ts`, `groupLine.ts`), a text with links
  sends each link's picture first, up to three, then the words
  (`apps/agent/src/linkPreviews.ts`). A note's link gets the note's drawn card,
  and any other link gets its page's `og:image` (or `twitter:image`), which Tex
  fetches and hosts itself (`pagePicture.ts`). Linq, WhatsApp and any later
  provider that attaches previews itself send links as before.
- A link at the very end of a text is what Messages splits off into the grey
  box, and a lone link is the same box. So a text ending with a bare link gets
  a full stop after it (it was "(tap the link)" until the owner, 2026-11-03:
  "can you just end it with a period"), and one starting with a link gets
  "Link:" before it. A link with words on both sides stays an ordinary tappable link, as the
  note-link sentence already showed.
- The fetch is held to the site reader's lock: public https names only, no IP
  literal or local name, every redirect checked again, no cookie or
  credential, 512 KB of a page, 5 MB of a picture, six seconds in all. It sends
  a preview-bot user agent, the way Apple's own fetcher does. Context's own
  catch-all card is never sent, because it says nothing about the link (a
  progress link, say).
- A picture is never the only way to the link, and never holds the words back.
  One that cannot be found, hosted or sent is skipped, and the words go anyway.

Undo by sending `text` instead of `tappable(text)` and passing no finder in
`sendWithLinkPictures`. Tests: `apps/agent/src/linkPreviews.test.ts` and
`pagePicture.test.ts`. They were sabotaged three ways: following a redirect
without the check, sending Context's catch-all card, and dropping `tappable`.
Each sabotage failed the matching tests.
