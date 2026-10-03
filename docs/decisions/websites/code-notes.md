# A website's design is code notes

_Decided by the owner, 2026-10-02 (design: "Context Sites"). Part of
[Bucket-backed websites](../websites.md)._

**Anyone asks their AI agent to build them a website.** The agent writes it
into the workspace's `website/` folder, the owner presses Publish, and Context
serves it. So a site's look has to be something an agent can write, and
something that cannot hurt the people who visit it.

## Everything in a site is a note

| File | What it is |
| --- | --- |
| `index.md`, `about.md`, … | Pages: the words, in Markdown. Each is an address. |
| `layout.html.md` | The frame around every page, with `{ content }` where the page goes. |
| `<name>.html.md` | A layout a page names with `layout: <name>`. One no page names is an all-HTML page at `/<name>`. |
| `<name>.css.md` | A stylesheet, applied to every page in name order. |
| `<name>.js.md` | A script. Never an address; not drawn yet (scripts need their own origin, below). |

A **code note** holds exactly one fenced block in the language its name says;
the prose around it is notes for people and agents and is never published.
Because every file is Markdown, `privacy.md`, history, live editing, comments,
activity and every agent tool work on a site's code with no new path through
the gateway. Layouts and stylesheets live at the top of `website/`; nested
`.html.md` files are HTML pages. A site with no code notes is drawn exactly as
before, so nobody has to write code.

**No shells, no catalogue of visual blocks** (the owner: "bloat"). Agents write
HTML and CSS better than any fixed block. Words go in Markdown pages so anyone
can edit them in the app; layout and look go in HTML and CSS; Context blocks
are only for workspace data (folder lists, forms, the waitlist field, embeds).
`orient` says exactly this to every agent in a context with a `website/`
folder (`apps/mcp/src/orient/websiteGuide.js`).

## Templates are a handful of fields and one loop

`{ content }`, `{ site.name }`, `{ page.title }`, `{ page.description }`,
`{ page.path }`, `{ page.intro }`, and `{ each x in site.nav }…{ end }` or
`{ each x in page.sections }…{ end }` (one section per `##`, with `heading`,
`text`, `link` and `content`). A field that does not exist, a loop without its
`{ end }`, a frame without `{ content }`, a `layout:` naming a missing file and
a code note without exactly one block are **Publish problems with a sentence
an agent can act on**, not silent fallbacks: a site that half-applies a layout
is a site the owner thinks is published and is not.

## No site code runs on context.lc

context.lc is the origin people are signed in on, and `WebsitePage` draws a
site inside the app. Script cannot be sanitized, only isolated, so:

- **HTML is rebuilt from tokens** (`packages/shared/src/siteDesign/html.ts`):
  a closed list of elements and attributes, every value decoded, checked and
  re-escaped, links to `http`, `https`, `mailto`, `tel` and relative paths
  only, pictures only from the workspace's own image store as `data:` URLs,
  ids prefixed `site-` so nothing can clobber a global the app reads, and the
  output balanced so a layout cannot close the element it is drawn in.
- **CSS is rebuilt from tokens** (`siteDesign/css.ts`): every selector scoped
  under `.ctx-site` (`:root`, `html`, `body` and a bare `.ctx-site` name that
  container, so a sheet written knowing it is scoped is not scoped twice), nothing
  that loads except a Google Fonts stylesheet, no escapes outside strings,
  functions from a closed list.
- **The server sanitizes, and the browser sanitizes again.** The resolver
  hands over a sanitized frame, layout and stylesheet; the page composes them
  with its own words (`composeSitePage`) and sanitizes the whole before it
  reaches the document. Text fields are escaped wherever they land; HTML
  slots (`{ content }`) are only filled between tags, never inside an
  attribute.

Unrestricted CSS and JavaScript belong on a host that never carries a login:
`<workspace>.ctx.site` (on the Public Suffix List, so every site is its own
origin) and custom domains, the model Webflow uses on webflow.io. `.js.md` is
recognised now so a script never becomes an address, and drawn only once it
has that origin.

A designed page scrolls in a box of its own (`DesignedSite.web.tsx`). The
app turns the document's scrolling off, and a site's author should not have to
know that; the first agent to build a long site found it could not be read
past its first screen.

An address that names a page by its file, `/index`, `/blog/index` or
`/about.md`, opens the page that file publishes when nothing is published at
it exactly (`websiteFileAddressAlias`), and a page's own link to one is
rewritten to the real address. No route ever ends in `/index`, so this shadows
nothing a site publishes; it does shadow a one-segment short link literally
named `index` once the site has a home page, which is the website-first rule
every other address already follows.

## Code notes publish like pages

A code note is a route-index row with a `code` role and no address. Publish
releases it with the pages; a visit draws a code note unchanged since Publish
from its live bytes and one edited since from the release copy, so saving a
stylesheet changes nothing a visitor sees. Its live bytes are read at the
publication clearance on every visit, so one `privacy.md` now holds back, or
one deleted, encrypted or drafted, stops being drawn at once. A members-only
code note is drawn only for members. Folder references (`folder:`) never make
a code note: a note a folder publishes is a note, whatever it is called.

## Designs are Premium

Websites are Premium (the owner, 2026-10-02), so designs are: on a deployment
that sells, a site whose plan is not paying is drawn with the default look and
its all-HTML pages are unavailable. A deployment that sells nothing
(self-hosted) has every feature. The design never gates the exit: code notes
are notes, and leave with everything else.

## What a simplification costs

Passing site HTML through, or filtering it with patterns rather than
rebuilding it, is an account takeover on context.lc the first time a filter
misses a spelling. Dropping the second sanitize lets a page's own words become
markup in a layout's attribute. Serving a code note at its own address
publishes an agent's notes to the internet. Letting a layout fail quietly
leaves an owner believing a site is published that is not.
`apps/convex/__tests__/siteDesignHtml.test.ts`, `siteDesignCss.test.ts`,
`siteDesignTemplate.test.ts`, `websiteCodeNotes.test.ts`,
`websiteDesign.test.ts` and `apps/mobile/__tests__/designedSite.test.ts` fail
if any of these comes back.
