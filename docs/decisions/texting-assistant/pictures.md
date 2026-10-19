# Tex makes pictures: graphics as a page, photos with Nano Banana 2 Lite (2026-10-19)

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
  calls Google's Gemini 3.1 Flash-Lite Image (Nano Banana 2 Lite), about
  $0.034 for a 1K picture. The call goes through the AI Gateway we already use,
  on Unified Billing, with no Google key and `cf-aig-collect-log: false`. The
  meter prices it as `google/gemini-3.1-flash-lite-image`. `AGENT_IMAGE_MODEL`
  can name another Gemini image model.

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
