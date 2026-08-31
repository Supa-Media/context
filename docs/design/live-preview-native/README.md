# The native shots — what they show, and what may not be in one

These are device screenshots of the iOS live preview and the accessory bar,
taken on a real phone against a real deployment. Three of them are gone, and
the reason belongs here rather than in a commit message somebody has to go
looking for.

## Never photograph a real note

`02b`, `07` and `08` rendered the owner's actual `todo.md`. Legible in the
committed PNGs, on a public repository: a named third party, internal project
names, a production command against a live deployment, where a set of
credentials is filed, a named kill switch, and the name of a repository secret
the note itself said had probably not been revoked yet.

CLAUDE.md's rule covers this exactly — *"no secrets, no internal hostnames, no
account identifiers, no customer data — not in code, tests, fixtures,
comments, commit messages, or docs"* — and the neighbouring
`docs/design/live-preview/README.md` had already applied it, saying its
Obsidian reference photo *"is not committed — it is a photograph of somebody's
own vault, and this repository is public."*

The rule was known. It was applied one directory over. This directory was the
one with no README, and it was the one carrying the data — which is why this
file exists, and why it says what it does rather than just listing filenames.

**Deleting them did not undo it.** They shipped in a public repository and are
in its history; treat anything that was legible as disclosed and rotate it.
That is the cost, and it is worth stating plainly so the next person weighs a
screenshot properly before committing one.

## What a shot may show

Use a context whose notes are scaffolded or written for the purpose — the
`index.md` a new brain arrives with is ideal, and `01`–`05b` are that. A shot
may show product chrome, a synthetic note, and an account name that is already
public elsewhere in this repository.

If a shot needs long realistic prose to demonstrate scrolling or wrapping,
write the prose. It takes a minute, and it is the difference between a picture
of the product and a picture of somebody's life.

## The remaining shots

| File | What it shows |
| --- | --- |
| `01-before-blank-editor.png` | The editor before a note is opened. |
| `02-note-renders-with-live-preview.png` | Live preview decorations on the scaffolded `index.md`. |
| `03-swipe-does-not-raise-the-accessory-bar.png` | A swipe over the note leaves the bar down. |
| `04-tap-places-caret-and-raises-keyboard.png` | A tap places the caret and raises the keyboard. |
| `05-typing-changes-the-document.png` | Typing marks the document dirty. |
| `05b-save-lights-up-bar-returns.png` | Save lights, and the bar returns after the keyboard goes. |
| `06-sidebar-no-bottom-bar-no-files-pill.png` | The sidebar open, with no bottom bar and no files pill. |
