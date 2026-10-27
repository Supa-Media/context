# App and console — spelling

### Spelling is Context's own checker, and the fix is under the word (2026-10-27)

The owner asked for spelling "like google docs does": click the red word, see
the fixes, pick one, ignore it or add it to a dictionary. What existed was the
browser's underline with nothing reachable under it. The browser keeps its
suggestions in its own context menu, which a page cannot open, read or add to,
so the note's menu could only point at Shift-right-click; the desktop app's
route to the operating system's checker (`webFrame.getWordSuggestions` behind
bridge version 8) came back empty in the app the owner uses.

So the note editor checks spelling itself (`features/console/files/spelling/`):

- **Hunspell dictionaries, read by `nspell`, on the device.** The files are the
  `dictionary-en` / `dictionary-en-gb` packages, copied into
  `public/spelling/` by `scripts/build-spelling-dictionaries.mjs` (run by the
  drawing-editor build, so every workflow that builds one builds the other)
  and fetched the first time a note opens — about 190KB gzipped — rather than
  bundled, because a dynamic import is not a lazy chunk under Metro (see the
  drawing editor's entry). **Nothing typed is sent anywhere to be checked.**
- **One underline, not two.** The browser's checker is switched off in the note
  body while ours runs and switched back on while ours has no dictionary
  (offline on a first visit), so checking never goes silent. Off in Settings
  means off for both.
- **Prose only.** Code, URLs, HTML, tags, front matter, `[[note links]]`,
  handles, paths, numbers, acronyms and identifiers are never underlined —
  what the old `spellcheck="true"` comment called an accepted cost is gone.
  A note somebody may only read is not underlined: every answer is an edit.
- **A plain click on a red word opens a card** with only the fixes, Add to
  dictionary and Ignore in this note — the editor's own menu, so it is a
  popover on a wide window and a sheet on a phone. The card leaves the
  keyboard with the note: the next key closes it, because a click inside a
  misspelled word is as often somebody about to fix it by hand. Right-click
  has the same rows above the formatting menu.
- **Words the person adds live on the account** (`spellingPreferences`, one
  row per person, deleted with the account), with a device copy so the first
  note paints right. The row holds only things shaped like one word, at most
  5,000 of them, so it cannot become a store for text out of a note. "Ignore
  in this note" is editor state and ends when the note closes.

**Not yet:** the iOS app's editor is a separate bundle in a WebView and keeps
the system's own checker, whose tap menu already offers replacements; grammar;
more than one language in a note; a workspace-wide dictionary.

**What reversing it costs.** Going back to the browser's checker brings back
the underline nobody can act on, and underlines under code. Bundling the
dictionary adds a megabyte to every page load.

**Tests that fail if it is reversed:** `editorSpelling.test.ts` (underline,
card, right-click, the browser attribute), `spellingWords.test.ts` (what is
prose, and suggestion order), `apps/convex/__tests__/spellingPreferences.test.ts`
(own row only, words only, bounded, leaves with the account).
