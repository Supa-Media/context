# File kinds

What kind of file a path names (a note, a sheet, or any other file) is
answered by one list, `packages/shared/src/fileKinds.cjs`, and never by a
hard-coded extension test. Decided with the owner, 2026-11-25, after Tex
ignored an open sheet because two places only passed `.md` (PR 4133).

## One list, not a `.md` on everything

An audit of `main` found about 150 places that asked `path.endsWith(".md")` on
their own. Each new text type had to be added to every one by hand, and the
sheet (`.csv`, [sheets](./sheets.md)) was missed in most of them: folder
listings, orient's counts, search, Tex's check-in, move, share links, copy,
offline. The six that had been patched (`|| .csv`) already disagreed. The
findings are in the `@supa` note `products/context-lc/file-types-audit.md`.

Naming every sheet `.csv.md` was weighed and turned down: it would push sheets
into the Markdown-only paths (the note editor, live co-editing, front matter,
forms), export would hand out `.csv.md` files no spreadsheet opens, and every
existing sheet would need renaming. The owner preferred one central list.

The list has three kinds. A **note** is `.md`, a **sheet** is `.csv`, and a
**file** is everything else: bytes Context stores and shows but never opens as
text. `isTextFilePath` is "text Context reads and writes" (listing, search,
visibility, saving); `isNotePath` is "Markdown on purpose" (forms, pages,
front matter, routines, Yjs co-editing). A new text type is one line in
`TEXT_KINDS`.

What a simplification would cost: a site that tests the extension itself is
the next place a new type is silently dropped.
`scripts/check-file-kinds.mjs` (fast guards and `pnpm precheck`) fails a pull
request that adds a `.md` or `.csv` test outside the list. The sites from
before the list are a baseline in `scripts/file-kinds-baseline.json` that only
shrinks: a file may not hold more than it allows, and `--update` writes the
lower counts back. `apps/mcp/test/fileKinds.test.mjs` pins the kinds.

## The extension is matched exactly

`Plan.MD` and `Data.CSV` are files, not a note and a sheet. The privacy
engine's exact-note parser (`apps/mcp/src/privacy/engine.js` and its control
plane port) matches `.md` and `.csv` as written, and one line it refuses makes
the whole manifest unreadable, which fails every note in the workspace closed.
A kind that ignored case let `set_visibility` write exactly that line for a
`.CSV`. Matching case in the list keeps every gate in step with the parser.

The two privacy parsers keep their literal tests and are exempt from the
guard: the engine imports nothing, and the port is tested against the engine's
own text. They now agree on sheets: the control plane's port refused a `.csv`
override the gateway accepted, so a sheet given its own visibility would have
failed the control plane's reading of the manifest closed.
`apps/convex/__tests__/privacyEngine/sheetOverride.test.ts` fails if they
drift again.
