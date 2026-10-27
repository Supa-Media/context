# Privacy and sharing — a linked page's card is its cover

### A linked page unfurls with its first screen (decided by the owner, 2026-10-27)

Tex delivers a job's result as a page (`.page.md`, see
[pages](../app-and-console/pages.md)) and texts a picture of its first
screen, the cover, with the link. The owner chose for that picture to be the
link's preview too ("Cover picture + link"), and then, with the trade in front
of them, chose it for **team links as well as links for anyone** ("Team links
too").

That is the one place a card shows a note's content, and it is a real
widening, recorded here so it is not rediscovered as a bug:

- **A team link's address is guessable** (`/note/@seyi/1-projects/plan.page.md`,
  `/console/@seyi?note=…`). Until now it unfurled with the title only, so a
  guess learned a name the owner had chosen to publish. For a page with a
  cover, a guess now learns its first screen. The probe space is unchanged:
  only notes the owner has explicitly linked answer at all, and a page nobody
  linked is the same answer as one that does not exist.
- **A link for anyone** (`/s/<token>`, or a short link) already lets its holder
  read the page, so the cover publishes nothing the link does not.
- **A link for named people keeps the title card.** Its token reaches people
  who were not on the list (a forwarded email, a link scanner), and they were
  never meant to read the page.

What carries it, each failing a test if removed
(`apps/convex/__tests__/pageCover.test.ts`, `infra/router/src/worker.test.ts`):

- **Only a `.page.md` note, linked as a note, for the team or for anyone**
  (`isCoverable` in `apps/convex/functions/lib/shares/pageCover.ts`). A folder,
  a plain note and a named-people link keep their title card.
- **The link must still be live and titled.** Revoking it, letting it expire,
  or turning its title off takes the cover off the card for future crawls, as
  it does the title. A card already unfurled cannot be taken back.
- **The cover is the customer's own bytes**, written to their bucket under
  `.context/assets/images/cover-<hash>-<hash>.png`, never named after the note.
  The control plane keeps only the leaf, on the page's tree row
  (`nodes.pageCover`), never the page's text.
- **Only a writer's turn sets it.** The gateway reports a cover it drew
  (`POST /gateway/page-cover`) with the person's own token, which must reach
  the workspace as owner or editor with `context:write`; the bytes must be a
  PNG of at most 2 MB, and the path a live page.
- **A new cover is a new address.** The card URL carries the cover's version
  as its cache key, because the edge cache cannot be purged.

**What a simplification would cost.** Drawing the cover at unfurl time would
make an anonymous crawler read the customer's bucket on every request. Keeping
the cover in our storage would leave a picture of their page with us after they
leave. Extending the cover to named-people links would show a page to whoever a
link was forwarded to.
