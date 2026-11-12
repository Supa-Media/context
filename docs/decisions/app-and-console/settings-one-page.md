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
- **The brand's look, not a phone's grouped list.** Paper ground, Libron
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
