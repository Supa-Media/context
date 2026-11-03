# App and console — Tex draws a picture for every page that has none

### A page with no picture gets Tex's ink drawing of its topic (decided by the owner, 2026-11-03)

The ask: "whenever Tex makes pages, can you have it generate an image
representing the page if there is no image already in the page, it should be
in tex style". Two rounds of artboards followed. On the first the owner chose
**"Tex draws it in ink"** over a picture from the image model, and then:
"use the more calm version of tex in these though, also most people won't be
generating images involving Tex". So the drawing shows **the page's own
topic** (a venue and a stage, a desk and a laptop, a clipboard and a hard
hat), with the calm Tex (the `#` with googly eyes, legs and a wave) small in
the scene. Round 2 was approved with "yeah build", including the wide card
below.

How it works:

- **It rides on the cover call Tex already makes for every page.**
  `draw_visual { template: "page", data: { path, scene } }`
  (`apps/mcp/src/agent/visuals/pageDrawing.js`). A page with no picture of its
  own and no `scene` is sent back with how to draw one, so a page is never
  texted bare. After `MAX_DRAWING_TRIES` (2) the cover is drawn without one, so
  a turn that cannot draw or save one (a read-only turn, a scene it keeps
  getting wrong) still ends.
- **"No picture" means** no `cover:` photo, no option photo, no embedded image
  and no map (`hasPicture` in `packages/shared/src/pages/cover.cjs`). Tex's own
  drawing does not count, so a page can be drawn again. A status page with a
  `number:` is left alone, because its cover is its number; one without a
  number is drawn like any other page (2026-11-03: a seven-day status page
  with no number came out as an empty dark band, with no drawing and no link
  picture; `numberCover` in `cover.cjs`).
- **The model writes shapes, never the picture.** The scene is SVG on a
  1200 x 900 canvas. `readScene` (`packages/shared/src/ink/drawing.cjs`) reads
  it into shapes and numbers and refuses anything else: an element outside the
  list, a path with anything but commands, a transform other than translate,
  rotate or scale, words outside `<text>`. `drawingSvg` then writes a new
  picture from what was read. No address, script, style or handler survives,
  and the screenshot Worker is asked to load nothing (`allow: []`).
- **What makes it Tex's is added by us, never left to the model.** There is
  one ink: Tex blue, or periwinkle on the dark page. A colour the model names
  becomes ink, and a fill is `none`, `ink`, `paper` or `hatch`. The app's brush
  filter is used, and the calm Tex comes from the app's own geometry
  (`packages/shared/src/ink/texFigure.cjs`, which the app now imports too:
  `apps/mobile/features/chaos/figureGeometry.ts`). Tex stands where the scene
  puts a `<tex>`, or at the scene's foot.
- **It is the customer's picture, saved in their page.** It is drawn twice,
  light and dark, at 1200 x 1000, and written into the page through
  `write_note` with the etag that was read. That makes it two uploads, named
  by `drawing:` and `drawing-dark:` in the front matter (`PAGE_PICTURE_FIELD`
  in `apps/mcp/src/notes/uploadedImages.js`). They borrow the note's
  visibility, `read_image` reaches them through the note, and export carries
  them, like any picture a page names.
- **The page shows it as its cover.** It always takes the split layout,
  because the plan's collage would crop a drawing to a strip. The light or
  dark drawing is shown by the page's own palette (`--pg-ink-light`,
  `--pg-ink-dark` in `css.cjs`).
- **The texted picture and the link card are one wide card.** For a drawn
  page, the cover is 1200 x 630: the kicker and title on the page's paper,
  the drawing beside them, and "Context, made by Tex" at the foot
  (`drawingCard` in `apps/mcp/src/agent/visuals/page.js`). The shrunken first
  screen it replaces was unreadable at link size. The control plane names a
  wide cover `card-…` from its PNG header, and its version ends in `-w`
  (`apps/convex/functions/lib/shares/pageCover.ts`). The edge then advertises
  1200 x 630 instead of the portrait size (`coverSize` in
  `infra/router/src/preview/meta.ts`). Who sees a cover is unchanged
  ([page-covers](../privacy-and-sharing/page-covers.md)).

**What a simplification would cost.**

- Letting the model's SVG through as written would put a stranger-controlled
  document in front of the screenshot Worker, and into every reader's page.
- Using the image model instead loses the one ink and the calm Tex, and costs
  about four cents a page.
- Keeping the drawing outside the note would leave the page's picture behind
  when the customer leaves.
- Dropping the floor puts back the bare pages the ask was about.

The tests that fail are in `apps/mcp/test/pageDrawings.test.mjs` (sabotage
record in its header) and in `apps/mcp/test/uploadedImages.test.mjs` ("a
page's photo fields…"). They also fail in
`apps/convex/__tests__/pageCover.test.ts` ("a wide card is named for its
shape…") and in `infra/router/src/worker.test.ts` ("a page Tex drew a picture
for unfurls wide…").
