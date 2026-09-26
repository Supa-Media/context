# App and console: a workspace's own emoji

## Custom emoji are pictures in the bucket, written as `:name:` in the note

Asked for by the owner on 2026-09-26: type `:` and a name to find an emoji,
add your own (GIFs included) from that menu, keep them in the workspace's
images, and import from Slackmojis without doing it by hand. The artboard the
owner confirmed is linked from the Context note `2-areas/apps/context/custom-emoji-2026-09-26.md`.

- **A note writes a custom emoji as `:name:`, and a standard one as the
  character.** `:name:` is what Slack and GitHub use, so Obsidian, GitHub and a
  text editor show readable text rather than a broken image link, and the app
  draws the picture over the text without changing the file
  (`files/emoji/emojiInline.ts`). A standard emoji picked from the menu, or a
  standard shortcode typed out to its closing colon, is written as the Unicode
  character, which every reader shows. A pasted `:tada:` still draws as 🎉.
- **Each emoji is one object, `emoji-<name>.<ext>`, in the image store**
  (`.context/assets/images/`, beside pastes). The object's name is the whole
  record: no list file, no table, so the bucket describes itself, an export and
  a handover carry the emoji, and one copied in by hand appears. `emoji-` is a
  namespace, not only a label: any member may read any object that starts with
  it, so nothing else ever writes such a leaf (pastes are `paste-`, agent
  uploads `upload-`, icons `icon-`). The name rule (`CUSTOM_EMOJI_NAME` in
  `@context/shared`) is inside the store's leaf class, so a name cannot build a
  leaf that walks out of the store. The bytes decide the type; SVG and HEIC are
  refused; 2 MB at most.
- **Every member sees every emoji; editors and owners change them.** An emoji
  has no note to borrow a visibility from and is drawn in any note that names
  it, so it belongs to the workspace like its icon. `read` takes a name, never
  a leaf, so it cannot return a pasted image. Removing or renaming one never
  edits a note: the old `:name:` shows as text.
- **Slackmojis is reached only by our server** (`functions/emoji.ts`), for the
  reason remote images are proxied: a picture drawn from another host tells it
  who is looking. The search goes to one fixed address; previews and imports
  are held to `emojis.slackmojis.com` and fetched through the shared remote
  image rule. Importing copies the bytes into the bucket once. A member cannot
  search, since the only use of a result is adding it.
- **The menu opens after `:` and two characters, where a shortcode can start**,
  so `10:30`, `http://` and YAML keys never raise it, and never in code, URLs
  or frontmatter. Workspace emoji rank first, then standard ones (GitHub's
  gemoji list, vendored by `scripts/build-emoji-data.mjs`), then, for editors,
  Search Slackmojis and Add a custom emoji. With no local match the menu asks
  Slackmojis and one press adds the result and writes it.

**What it does not do yet, stated.** The native (iOS/Android) editor draws
workspace emoji and offers standard ones, but its `:` menu does not list the
workspace's own or offer Add, because the list would need a new bridge
message; Settings › Emoji works there. GIFs animate regardless of reduced
motion. Agents write `:name:` like anyone, but have no tool to add an emoji.
There is no "frequently used" ranking.

**What a simplification of this costs.** A list file beside the pictures is a
second record that can disagree with the first. Letting `read` take a leaf
makes it a way to fetch any pasted image in the workspace without the note
that gates it. Fetching Slackmojis from the browser brings back the tracking
pixel, and dropping the host lock turns preview and import into an open fetcher.

The checks are `apps/convex/__tests__/customEmoji.test.ts`,
`apps/convex/__tests__/files/customEmoji.test.ts` and
`apps/mobile/__tests__/customEmojiEditor.test.ts`.
