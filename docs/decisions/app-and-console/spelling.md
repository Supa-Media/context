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
- **No line from the browser either.** The browser's checker is switched off
  in the note body while ours runs or loads, and back on only when ours could
  not load (offline on a first visit), so checking never goes silent. Off in
  Settings means off for both.
- **Prose only.** Code, URLs, HTML, tags, front matter, `[[note links]]`,
  handles, paths, numbers, acronyms and identifiers never get fixes. A note
  somebody may only read gets none, and never downloads the dictionary:
  every fix is an edit.
- **Right-click a misspelled word** for the fixes, Add to dictionary and
  Ignore in this note, above the formatting menu (a long press where the
  phone's browser reports one as a right-click).
- **Words the person adds live on the account** (`spellingPreferences`, one
  row per person, deleted with the account), with a device copy so the first
  note paints right. The row holds only things shaped like one word, at most
  5,000 of them, so it cannot become a store for text out of a note. "Ignore
  in this note" is editor state and ends when the note closes.

### No red line: the fixes wait for a right-click (2026-10-28)

The first build drew a wavy red underline under every misspelled word and
opened a card on a plain click. Notes are full of names, titles and coined
words, so the line marked almost everything and took over the page. The owner
asked to leave the line out and keep the suggestions. Nothing is drawn now,
by us or by the browser, and a plain click is only a click: with no line to
point at it, a card opening on a click would come out of nowhere. The checker,
the account dictionary, Ignore in this note and Settings › Spelling are
unchanged. An iPhone browser, which reports no long press on text as a
right-click, has no way to reach the fixes; the iOS app keeps the system's
checker.

**Not yet:** the iOS app's editor is a separate bundle in a WebView and keeps
the system's own checker, whose tap menu already offers replacements; grammar;
more than one language in a note; a workspace-wide dictionary.

**What reversing it costs.** Going back to the browser's checker brings back
an underline nobody can act on, under code too. Drawing our line again brings
back a page marked red wherever a name or a coined word is. Bundling the
dictionary adds a megabyte to every page load.

**Tests that fail if it is reversed:** `editorSpelling.test.ts` (nothing
drawn, a plain click is a click, right-click fixes, the browser attribute), `spellingWords.test.ts` (what is
prose, and suggestion order), `apps/convex/__tests__/spellingPreferences.test.ts`
(own row only, words only, bounded, leaves with the account).
