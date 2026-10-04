/**
 * How an agent builds this context's website, shown by `orient` when the
 * context has a `website/` folder. Short on purpose: the full rules are the
 * site's own (docs/decisions/websites/code-notes.md), and an agent that has
 * this much can write a site Publish accepts.
 */

export const WEBSITE_ROOT_PREFIX = "website/";

export const WEBSITE_GUIDE = [
  "## Building this context's website",
  "",
  "`website/` is this context's website. Every file in it is a note.",
  "",
  "- **Saving is not publishing.** Owners and editors use write_note `site`: `{ action: \"check\" }` lists addresses, broken links (note and line), pictures, what the cleaner removed and why, and empty pages (`inspect: \"website/x.css.md\"` shows a note as drawn); `{ action: \"publish\", draft }` releases the draft you checked; `{ action: \"screenshot\", page: \"/\" }` then shows it at phone, tablet and desktop width; `{ action: \"history\" }` lists the last 5 publishes; add `revision` for one's files, to write back as the draft. Others ask someone to press Publish.",
  "- **Pages** are ordinary notes: `index.md` is `/`, `about.md` is `/about`. Frontmatter: `title`, `description`, `nav: 1` (menu order), `layout: cards`, `draft: true`. Link to a page by its address (`/`, `/about`), not its file (`/index`).",
  "- **`layout.html.md`** is the frame around every page: header, logo, nav, footer, and `{ content }` where the page goes.",
  "- **`<name>.html.md`** is a layout a page picks with `layout: <name>`; one no page names is an all-HTML page at `/<name>`.",
  "- **`<name>.css.md`** is a stylesheet for every page, scoped to the site for you: `:root`, `html` and `body` mean the site and every other selector is placed inside it, so never write `.ctx-site`. Colours and fonts go in `:root` variables; `@import` Google Fonts.",
  "- A small base sheet comes first (a `--width: 44rem` text column, heading margins, link colour); yours overrides it, and `base: off` in a stylesheet's frontmatter drops it. The page scrolls by itself: no full-height scroll boxes, no `overflow: hidden` on `body`.",
  "- A code note holds exactly one fenced block in the language its name says (```html, ```css); prose around the block is notes for people and agents, never published.",
  "- Layout fields: `{ content }`, `{ site.name }`, `{ page.title }`, `{ page.description }`, `{ page.intro }`, and loops `{ each item in site.nav }…{ item.link } { item.title } { item.current }…{ end }`, `{ each s in page.sections }…{ s.heading } { s.text } { s.link } { s.content }…{ end }` (one section per `##`).",
  "- HTML and CSS are cleaned before they are drawn: no scripts, event handlers, forms, iframes or SVG; pictures only from this workspace: attach them with write_note `images` in the same write, and `src=\"logo.png\"` or `url(logo.png)` is pointed at the stored copy; no remote `url()`.",
  "- Published at `context.lc/@<handle>`, `<handle>.ctxlc.site`, and any domain the owner connected.",
  "- **Scripts run sealed, or not at all.** Site scripts are not available yet, and when they are, each one runs sealed in its own box on the page: fine for a calculator, quiz or chart, never touching the rest of the page. Tell the person this when they ask for a site: no analytics or tracking snippets, chat bubbles, cookie banners or third-party scripts, nothing that changes the whole page. Do sticky headers, scroll effects, menus and dark mode in CSS instead.",
].join("\n");

/** The guide, when this connection can see a website folder. */
export function websiteGuideFor(survey) {
  const has =
    survey.folders.some((folder) => folder.prefix === WEBSITE_ROOT_PREFIX) ||
    survey.rootNotes.some((note) => note.key.startsWith(WEBSITE_ROOT_PREFIX));
  return has ? WEBSITE_GUIDE : null;
}
