# Settings is one page

### Settings is one scrolling page, each row one line and one action (2026-11-12)

Dev2, with screenshots of another assistant's settings: *"can we make tex/context
settings as sleek and simple as this? using our existing styling"*. Five mockups
later (v5 approved, *"nice, build"*), settings opens on one page instead of a
searchable index beside a panel.

- **One page, every setting.** Sections: Text Tex, Your account, Tex, Workspace,
  Your data. The pages people rarely open sit under one "More" line at the foot
  of their section, so the page is about two phone screens rather than five,
  and nothing is reachable only by typing its name. The search box is gone.
- **A row is a name, one line and one action.** The action either happens in
  place (copy an address, pick a look, download, sign out) or opens that
  section's page, which is the same panel and the same `?settings=<key>`
  address as before. Never two controls on one row.
- **(Replaced 2026-11-13, see below.) The brand's look, not a phone's grouped list.** Paper ground, Libron
  headings, "Settings." with the blue period, lettermark tiles for things
  (you, the vault, people, apps), small type (15/13). Dev2 on the grouped grey
  cards with capital labels: *"feels ai"*; on the app's own sans-only version:
  *"doesn't fully feel like it's in a context style"*. Colours are
  `design/tokens/settingsHomeColors.ts`, light and dark.
- **A wide window opens on the same page.** No sidebar: a section is a page
  pushed over the home, and the bar's left control says "Settings" to go back.
- **The Tex rows are the list Tex reads.** The Tex section's "More" draws
  `TEX_SETTINGS` (`packages/shared/src/texSettings.cjs`), the list Tex uses when
  someone texts it a change, so the page and the chat never name different
  settings. Rows with a page of their own (how Tex talks, the vault, the apps
  Tex uses) are not drawn twice.
- **Leaving stays on the page.** "Download as folders" is a row of Your data,
  never folded under More (non-negotiable #1).
- **Row titles are the pages' own names** ("People & sharing", "Connected
  apps", "General"), because Tex and the help notes send people to
  "Settings → People & sharing".

What a "simplification" would cost: putting the search box or the sidebar back
brings back the index Dev2 asked to replace; drawing the Tex rows by hand
splits the page from what Tex can change by text.
Tests: `__tests__/settingsHomeModel.test.ts` (every section is a row, the Tex
rows equal the shared list), `settingsOverlayRender.test.ts`,
`settingsFrame.test.ts`, `e2e/webkit/settings.spec.ts`.

## Rebuilt from the reviewed prototype (2026-11-13)

Dev2 rejected the first build on sight (2026-11-12: "no way to switch
workspaces or see how settings affect different workspaces, the color does not
match the rest of the app") and the next prototype on its words and layout
(2026-11-13: "way too much jargon and slop text", "the layout is horrendous").
The page was rebuilt to a clickable prototype that went through three UX
reviews against the reference screenshots, and Dev2 said "build". What changed
from the list above, and replaces it where they differ:

- **The app's own colours and type.** `useColors` and Instrument Sans; the
  paper sheet, Libron headings, the blue period and the lettermark tiles are
  gone.
- **A row's line is its value**, never a sentence about the setting: "3
  people", "Healthy", "seyi@context.lc". A row with nothing to state shows its
  name alone. No section ledes, no scope captions.
- **Nothing is folded.** Every row is on the page as it opens; "More" is gone.
- **The workspace is a section of its own, last before Data controls.** Its
  heading is followed by its picker (the workspace's mark, `@name`, and "Shared
  · Owner"), and every row under it belongs to the workspace picked there.
  Everything above it follows the person into every workspace.
- **Tex settings changed by text are one row** ("Check-ins, quiet hours and
  more", "Text Tex") until the app has their switches, rather than a column of
  rows with nothing to press.

Tests: `settingsHomeModel.test.ts` adds "a row's line is its value" (seven
words at most, no full stop) and "the Workspace section comes after everything
that follows you, and holds only workspace sections".

## Switches for what Tex changes by text (2026-11-13)

The "Text Tex" row is gone: "Check-ins, quiet hours and more" (`panels/TexHabits.tsx`) opens a page with a switch or a
choice for each `via: "setting"` row of `TEX_SETTINGS` (check-ins, quiet hours, texts from their other AIs, the
overnight About me rewrite, the daily tidy). It reads them from the Tex page's `settings` list (`habits`) and changes
them with `setting.set`, which calls the same handler a text does (`agent/settingsTools.js` `settingSet`), so a value
the chat would refuse is refused in the app too and the two can't disagree. The person's own chat only, like
`send setting`. `settingsHomeModel.test.ts` fails when the panel and the registry name different switches.
