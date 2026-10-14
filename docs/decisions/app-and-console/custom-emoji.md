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
There is no "frequently used" ranking. A published website draws the emoji
its pages use; see [websites](../websites.md#a-pages-emoji-travel-with-the-page).

**What a simplification of this costs.** A list file beside the pictures is a
second record that can disagree with the first. Letting `read` take a leaf
makes it a way to fetch any pasted image in the workspace without the note
that gates it. Fetching Slackmojis from the browser brings back the tracking
pixel, and dropping the host lock turns preview and import into an open fetcher.

The checks are `apps/convex/__tests__/customEmoji.test.ts`,
`apps/convex/__tests__/files/customEmoji.test.ts` and
`apps/mobile/__tests__/customEmojiEditor.test.ts`.

## A folder icon is any emoji, a workspace's own included

Decided by the owner, 2026-10-08: the thirty-six emoji "Set icon…" first
offered (the workspace icon's list) were too few. A folder icon is any single
emoji, found by the same search the editor's `:` menu runs, pasted from the
keyboard's own picker, or one of the workspace's own, which is stored the way
a note writes it, `:name:`, and drawn from the same pictures. "Add emoji…" in
the picker is the provider's own Add dialog, so a new emoji becomes the icon in
one step.

The icons stay in one bucket file, `.context/folder-icons.json`
(`packages/shared/src/folderIcons.cjs`), not in each folder's front note: one
read draws every row of a listing. Setting `:name:` is refused unless that
emoji exists, so an icon never names a picture nobody can draw; one removed
later shows the plain folder glyph. Every place that draws a folder icon (tree,
listing rows, Home, the folder page's title) draws it through `EmojiGlyph`.

**Reversing it** ("only a curated list") costs the owner's ask; storing a
workspace emoji's picture rather than its name would copy bytes the image store
already holds. `folderIcons.test.ts` (Convex) and `folderIconRender.test.ts`
(app) fail if either the `:name:` rule or the drawing goes.

## Built-in folders have a default emoji, and notes can have one

Decided by the owner, 2026-10-13 ("can we make default emojis for these
folders, also can we add emojis to plain notes like activity"), reversing the
2026-10-08 "no folder gets a special icon" for the built-in folders only.

- **Defaults are drawn, never written.** `defaultFolderIcon` in
  `folderIcons.cjs` gives a top-level folder its role's emoji (Inbox 📥,
  Projects 🏗️, Areas 🛠️, Resources 📚, Clients 🤝, Teams 👥, Products 📦,
  Archive 🗄️, and `website` 🖥️). Nothing goes into the bucket, so every
  workspace has them without a migration, an icon somebody chose always wins,
  and removing it ("Use default 📥") brings the default back. Somebody's own
  folders keep the plain folder glyph. The folders the product itself files
  into one level under the inbox get one too (the owner, 2026-10-14):
  calendar 🗓️, contacts 📇, email ✉️, forms 📝, google-chat 💬, imessage 📲,
  meetings 🎙️, memories 💭, sessions 🤖, granola 🥣, and the capture folders
  📨 (`DEFAULT_INBOX_FOLDER_ICONS`). Exact name, exact depth: `1-projects/email`
  and `0-inbox/email/archive` are somebody's own.
  Tex's folder gets them too (the owner, same day): `tex` ✨, `tex/about-me.md`
  🪪, `tex/routines` 🔁, and each how-often folder under it by what its name
  means (`cadenceFromFolder`): once 📌, minutes ⏱️, hours ⏳, days ☀️, weeks 📅,
  months 🌙, yearly 🎆.
- **A note's icon is one more key in the same file**, the note's own path
  (`todo.md`). The file keeps its name because it is a stable on-bucket format.
  A note's icon is read back only when the note itself is visible (`canSee`),
  never on the strength of its folder: a note held back inside a shared folder
  must not leak through its emoji. It follows the note through every move, in
  the console and through `move_note`, `move_notes` and `archive_note`
  (`remapIcons`, one write per batch), and goes when the note is deleted for
  good. Only Markdown notes can have one; a picture or a PDF cannot.
- In the tree a note's emoji sits in the folder glyph's slot; a note with none
  draws the plain note icon there, the way a folder draws the plain folder
  icon, and an editor clicks either to open the picker (the owner, same day).
  Folder pages draw it in place of the file glyph.

**Reversing the visibility rule** (a note's icon shown with its folder) leaks
held-back notes' names; `folderIcons.test.ts`'s "a member never sees the icon
of a note held back" fails.

## The picker suggests an emoji, and offers a random one

Decided by the owner, 2026-10-14, after first asking for every new or renamed
folder and note to be given an emoji on its own and then taking that back
("don't add emojis immediately, automatically"). Nothing gets an icon unless a
person picks one. Opening the picker shows two quick picks above the grid:

- **Suggested**: Clef reads the name alone (never a note's text, never its
  folders) and answers two choice questions, a topic and then an emoji in it,
  from the list in `packages/shared/src/iconSuggest.ts`. Every emoji in that
  list is one the picker offers under the same shortcode
  (`folderIconPicks.test.ts`), so a suggestion is never something a person
  could not have picked by hand. A name that says nothing (`untitled-…`,
  `New folder`) is not sent. Metered as the `iconSuggest` feature, every plan,
  editors only (`folderIcons.suggest`).
- **Random**: one from the same list, with Shuffle to roll again.

**Assigning icons automatically** would fill `folder-icons.json` with picks
nobody made, and the owner said no.

