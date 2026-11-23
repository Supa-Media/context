# App and console: the vault is its own place on the right rail

## The vault is a tab on the right rail, and a phone's account sheet button, not a page of Settings (2026-11-23)

Decided by the owner, 2026-11-23, reversing where Settings › Vault put it on
2026-10-16 ("put it in settings"): *"I want to move the vault to the right
panel … it's not really supposed to exist in settings, at least on web and
desktop, and it's kind of its own thing"*. The keys an AI client uses without
seeing them are a place of their own, beside Meetings and Tex, not a row
between Connected apps and Storage.

- **On a layout with a right panel** the rail has a key icon after Tex, the
  Vault tab, shown only with a workspace open (never on the demo, to a
  visitor, or on the landing page). It draws the same list and detail Settings
  drew, at the panel's width: the list, then a picked key in its place with
  one back row. The rail is the panel's only chrome, so there is no "Vault"
  title inside it; the count line is the head.
- **On a phone**, which has no panel, Vault is a button on the account sheet
  right after Tex, in the rail's order, and opens a page where a note would be,
  headed the way the Trash page is.
- **Its address is `?vault=1`**, beside `?trash=1` and `?meetings=1`. A
  pointer layout opens the tab once and takes the parameter off; a phone keeps
  it for its page. `?settings=vault`, which emails already sent carry, still
  lands on it. Settings has no Vault section left, so its search no longer
  finds one.
- **Every screen inside it is headed by one row** (`VaultBackRow`): ‹, the
  name, a muted line under it, and one small action at the end. A key, a key
  being edited and New key all use it, so no screen has a large title and a
  separate Cancel (the owner on the old New key head: "what the heck is this
  ugly header").
- **No mark of its own on the rail.** A key's first use waiting for a yes is
  counted on the Tex tab, where it is answered
  ([approvals-in-tex-chat](./approvals-in-tex-chat.md)); a second mark on the
  key would count the same ask twice.

**What a simplification of this would cost.** Putting the vault back in
Settings hides the one place people manage what their AIs may use behind a
page about preferences, and leaves the links in sent emails opening a section
that is not there. `consoleChrome/vaultPlace.test.ts` fails if `?vault=1` or
`?settings=vault` stops opening the tab, if a phone loses its Vault button, or
if a pointer layout grows one in its menu; `asideTabs.test.ts` fails if the
tab shows without a workspace; `settingsSections.test.ts` fails if a Vault
section returns.
