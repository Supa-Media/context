# Tex makes pictures: graphics as a page, photos with Nano Banana (2026-10-19)

The owner asked for "a decently capable and cheap image generation
capability": graphics made the way Claude makes them, as a page that is then
photographed, and photo edits like "show me how I look in this dress" from a
cheaper image model that stays consistent, under 5 cents a picture. Tex has two
`send` actions for this (`apps/mcp/src/agent/pictureMaker.js`):

- **`draw_picture`** takes one HTML page and a size (200-2000 by 200-2400,
  1080 square by default). The screenshot Worker sets the page in a fresh
  browser context and returns a PNG (`infra/site-shots/src/render.ts`, POST
  `/render`).
- **`make_picture`** takes a prompt and up to four pictures to work from. It
  calls Google's Gemini 2.5 Flash Image (Nano Banana), about $0.039 for a 1K
  picture. The call goes through the AI Gateway we already use, on Unified
  Billing, with no Google key and `cf-aig-collect-log: false`. The meter prices
  it as `google/gemini-2.5-flash-image`. `AGENT_IMAGE_MODEL` can name another
  Gemini image model.

Both hand back an image block inside the turn's `outgoingPictures` dispatcher,
so the picture is numbered and texted with `[picture N]` like any other. Both
are offered only on a texted turn, the only kind that can send a picture.

**Why this model.** It was compared on 2026-10-19 against these:

| Model | Price | Why not |
|---|---|---|
| Seedream 5.0 Lite | 3.5¢ | Strong, but a new vendor and key |
| GPT Image 2 (low) | 0.6¢ | Faces drifted in edit tests |
| FLUX.2 klein | about 1¢ | Takes 4 references and holds identity less well |
| Nano Banana 2 | 6.7¢ | Over the 5¢ budget |
| Nano Banana Pro | 13.4¢ | Over the 5¢ budget |

Nano Banana 2 Lite takes up to 14 references, edits over several turns, and
Google rates its character consistency at the original Nano Banana's level. Its
output is 1K and carries SynthID.

**What a picture may be made from.** A picture can come from `attachment:N` (a
photo sent with this text), `picture:N` (one a tool showed this turn, already
privacy checked) or `last-picture`. A drawn page loads an https image only if
its exact address was written by the person or shown by a tool this turn, the
rule `[picture https://…]` follows. Google Fonts are the one fixed exception.
The Worker checks every request the page makes, a CSS `url()` or a navigation
alike, so an address the model built cannot carry a note's words to someone's
server. Scripts are off and resource hints are disarmed, because a socket or a
DNS lookup would leave without a request to stop.

**The same person, edit after edit.** The model holds nothing between calls.
The last picture `make_picture` made is kept, with up to two of the photos it
came from, at `.context/agent/conversations/texts-picture.json` in the person's
own bucket, and `last-picture` hands all of them back. It is kept only when
every source was theirs: a photo they sent, or the picture kept before. A
picture made from a note's picture is not kept, so it stays in the turn that
was allowed to see the note. Tests: `apps/mcp/test/agentPictureMaker.test.mjs`
and `infra/site-shots/src/render.test.ts`.

**Make first, then ask (owner, 2026-10-19).** "Make me a poster for a picnic
on Sunday" came back as questions about the time and place. Tex now makes a
first picture in the same turn, guessing what was left out, and offers to
change it (`PICTURES_LINE` in `outgoingPictures.js`; checked in
`agentOutgoingPictures.test.mjs`).

**Nano Banana, not Nano Banana 2 Lite, for now (2026-10-19).** The first photo
edit in production failed: Unified Billing does not cover Gemini 3.1
Flash-Lite Image yet, so the gateway sent it to Google without a key and
Google answered 403 "Method doesn't allow unregistered callers". Image Model
Probe (`.github/workflows/image-model-probe.yml`) showed Gemini 2.5 Flash
Image answering through the same gateway, at about 3.9 cents a picture, still
under the 5-cent target. Run the probe with the 3.1 model id to see when it
is covered, then switch `IMAGE_MODEL` back.

**A photo outlives its text (2026-10-19).** Dev's "try again", one text after
a failed "make our clothes blue", got "send the photo again": attachments lived
for one turn. Now the last text with photos keeps up to four of them in the
person's bucket at `.context/agent/conversations/texts-photos.json`, written
before the turn runs, and `earlier-photo:N` names them. Only a kept texted
turn writes it, and the next text with photos replaces it. The saved
conversation still holds names only. Test: "a photo from an earlier text is
still there" in `agentPictureMaker.test.mjs`.

**A made photo is bigger than one stored value (2026-10-19).** Dev's blue
edit was made and then answered "I couldn't send that picture just now".
Sendblue fetches a picture by address, so the agent Worker keeps its bytes in
the sender's Durable Object for half an hour (`apps/agent/src/media.ts`), and
a stored value there is capped at 2 MB; the image model's photos run past it.
The bytes are now kept in pieces under that cap, up to 8 MB in all, and are
pruned together. Test: "keeps a photo bigger than one stored value" in
`apps/agent/src/media.test.ts`.

**A big photo goes as a JPEG (2026-10-19).** On top of the pieces, the agent
Worker turns any picture over 1 MB (GIFs aside) into a JPEG at quality 85,
2048 pixels on its longest edge at most, through the Cloudflare Images
binding it already has for HEIC, before upload (`shrinkPicture`,
`apps/agent/src/outgoing.ts`; Dev's call). Under 1 MB a poster stays PNG and
sharp. Without the binding, or when Images refuses, the picture goes as it
was. Test: "sends the shrunk JPEG, not the PNG" in
`apps/agent/src/outgoing.test.ts`.

## A picture is read on its own turn, whatever model answers (a review of a chat, 2026-10-24)

A person texted a screenshot of their chat with a tailor, then a second
showing "Sunday after 3pm" agreed. Tex searched email and asked "Is there a
time you want me to block?" ("are you dumb? we literally just agreed").
Three changes:

- The setup's fallback (a Workers AI model) can't see pictures. A turn
  carrying one whose model fails now goes on with the setup's other model
  that can (Opus after Haiku, Haiku after Opus), and only with none on the
  blind one (`pictureFallback` in `apps/mcp/src/agent/attachments.js`; the
  turn's fallback may be a function of the failed model, `turn.js`).
- The turn is told to look at the pictures before anything else, and to take
  what a screenshot shows (a time agreed, a place, a name, an amount) as
  settled rather than asking for it or searching for it elsewhere.
- An answer that asks them anything while a picture came with the text gets
  one more round to look at it again (`PICTURE_NOTICE`, `replyChecks.js`).

We could not see which of these happened on that chat: the Worker's logs and
the turn reports were not readable from the session that made this change.
Undo: drop `pictureFallback` from `route.js`; `agentProduction.test.mjs` "a
picture turn whose model fails…" fails.
