# Privacy and sharing — a note link Tex texts unfurls with the note's name

### A note link Tex texts carries the note's name and a key, and unfurls as that note (decided by Dev, 2026-11-23)

Every note link Tex texted (`/note/@seyi/<path>`, `/p/@seyi/<page>`) unfurled
as one frozen card, "A note in Context", whatever it named, so a chat of links
all looked alike. The address is guessable, which is why: a card drawn from it
would tell anyone who guessed a path what a private note is called.

Dev chose to show the name anyway, **through a key, not through the
address** ("Yes, with a secret key"). Tex adds the note's name and a key to
the links it texts,

    /note/@seyi/areas/spirit/1-timothy-1.md?t=1%20Timothy%201&k=<22 characters>

and only a link whose key matches gets a card with that name on it: the name,
the note's last two folders, one of seven backdrops picked from the address,
and Tex doing something that fits the name (or the app's # when nothing fits).
The look is the round-4 artboard Dev approved ("Amazing. lets go with this").

What this trades, recorded so it is not rediscovered as a leak:

- **A texted link now tells whoever holds it the note's name.** Forwarding the
  text, or a link scanner reading it, shows the name on a card. It never shows
  the note: opening the link is still a sign-in and the app's own permission
  check, and the key grants nothing.
- **A guessed address still tells a stranger nothing.** Without the key, or
  with a key for any other workspace, path or name, the card is the frozen one,
  byte for byte, so there is nothing to probe.
- **Nobody can make a context.lc card say something Tex did not text.** The key
  is an HMAC-SHA256 (16 bytes, base64url) over the workspace, the path and the
  name, under a key derived from `GATEWAY_SECRET` with the label
  `context.note-preview.v1`. Changing that secret retires every key at once.

What carries it, each failing a test if removed:

- **Signed at the finish step, never by the model.** A read or write keeps its
  link's signed twin, and the finish step swaps it in (`noteLinks.js`,
  `withPreviewLinks` in `packages/shared/src/notePreview.cjs`); the model is
  shown only the plain link. A link the model retyped, or one from an earlier
  turn, goes out plain and unfurls frozen
  (`apps/mcp/test/replay/cases/note-link-unfurls-with-name.mjs`).
- **The name is the note's own**: its first heading, else its file name as
  words, cut to 80 characters with control and format characters removed
  (`noteTitleOf`, `cleanTitle`). A name that is not already clean never
  verifies.
- **The control plane checks the key; the router only checks shape.**
  `/note/preview` and `/note/card` (`apps/convex/functions/lib/publicRoutes/noteLinkCards.ts`)
  are unauthenticated, answer only for a key that holds, read no note, row or
  bucket, and give one null shape (or a 404) for every refusal
  (`apps/convex/__tests__/noteLinkCards.test.ts`). The router
  (`infra/router/src/noteLinkCards.ts`) shows only a name the control plane
  answered with, and keys the card's cache on the checked parts, never the URL
  as sent (`infra/router/src/noteLinkCards.test.ts`).
- **No tofu.** A name the card's faces (Libron, Instrument Sans) cannot draw
  keeps its name in the tags and the product picture (`isRenderableNoteCard`).

The picture Tex texts ahead of a note link on Sendblue lines (`noteCards.ts`)
is the same card, drawn from the same link, so the picture and the unfurl
match.
