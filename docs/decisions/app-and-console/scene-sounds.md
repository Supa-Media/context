# App and console: a cast scene's sounds

## A scene's sounds are chosen in the note, and an uploaded one is stored like a pasted image

The cast studio plays a sound at each moment of a scene: someone joins, an agent
pops in, typing, an agent's words land, a comment is sent, a thread is resolved,
a note appears. Dev2 chose (2026-09-29) a built-in set plus uploads, one sound
per kind of moment for the whole scene.

- **The choice lives in the scene note**, as one front matter line naming only
  what differs from the defaults: `sounds: [comment bell 70%, agent
  sound-0123456789abcdef.wav, all off]`. It is written through the same
  `setNoteProperty` the Properties panel uses, so it saves and merges like
  typing and leaves with the note. A line the studio cannot read is ignored,
  never refused, because the note is somebody's text.
- **Built-in sounds are code**, recipes in `features/studio/sounds/synth.ts`
  played with Web Audio: nothing to download, nothing licensed.
- **An uploaded sound takes the pasted-image road.** It is stored in the
  workspace's own bucket, in the asset store (`.context/assets/images/`,
  named for history, now "assets that are not notes"), as
  `sound-<hash>.<ext>`. It is read back through `readNoteImage`, so it is
  served only for a note this viewer can see that names it, and it follows
  that note's privacy. It is an existing folder, not a new layout.
- **The bytes decide what a sound is.** A declared `audio/*` type only routes
  the upload. `sniffSoundType` (`packages/shared/src/sceneSounds.ts`) must
  find an MP3, WAV, Ogg or M4A header, the file is stored under the type those
  bytes name, and `writeImage` checks again that the bytes match the
  extension. At most 2 MB. The store allow-list gained exactly `audio/mpeg`,
  `audio/wav`, `audio/ogg` and `audio/mp4`.
- **Agents do not get sounds through `read_image`**, whose types must equal the
  store's image types (`writeImage.test.ts`). Sounds are for the studio.
- **The homepage never plays a sound.** Only the studio does, at cues its stage
  reports, and a step rushed past on a jump makes none.

Tests: `apps/convex/__tests__/files/sceneSounds.test.ts` (sniffing, refusals,
note-gated reads), `apps/mobile/__tests__/castSounds.test.ts`, and
`e2e/webkit/castStudio.spec.ts`.

## The script is edited on the studio's rail, and the note stays the only copy

Dev2 asked (2026-09-30) to edit a scene's script in the studio: its words, who
does each step, its timing and its characters, and to see an agent's changes to
it live.

- **Every edit rewrites only the lines of the step it changed**
  (`packages/shared/src/castEdit.ts`, spans from `castStepSources`). The rest of
  the page, comments and blank lines inside the block included, stays exactly as
  written, and a changed step is written back in the grammar's plainest words.
  Edits go through the room like the pace and sounds lines, so they merge with
  anyone typing and with an agent's write.
- **Words are typed over where they stand**, and the note changes once, when
  they are kept (Enter or leaving the field), never per letter. Timing is the
  scene's pace plus its pauses, which are steps like any other.
- **A change the studio did not make is marked** on the rows it touched for a
  few seconds, named after the agents in the note at that moment (a tool is in
  the room only while it writes), else the people in it. A step rewritten counts
  as changed, not as removed and added.
- Colours stay derived from the order people appear in; the studio does not
  store them.

## A scene can be a chat with an assistant, and its workspace steps are real

Dev2 asked (2026-09-30) for scenes where somebody chats with Claude, ChatGPT or
both in another app, and the viewer watches the workspace change as it happens:
"seeing folders move, notes get renamed, project items status getting updated
in list view all in real time". The artboard was approved first.

- **The chat is a stand-in, not a copy.** `@maya asks Claude: …` opens a window
  named as the script names the assistant, drawn in the system's own sans and
  one of three looks (warm, plain, dark) that are no product's. Nothing of a
  real app's marks, colours or wording is drawn; the badge is the cast member's
  presence colour, as everywhere else in a scene.
- **Each workspace step shows in the chat, then lands, then shows done.** The
  steps are the ones an assistant takes through the MCP: `adds folder`,
  `adds note: folder/name`, `moves … into:`, `renames … to:`, `marks … as:`,
  `adds task to …:`. With a chat open, a step appears under "Used Context" as
  working, the change lands a beat later, and the row turns done, so the eye goes
  from the chat to the tree. Without a chat the same steps simply happen.
- **They change the visitor's copy of the site through the same code a visitor's
  own change takes** (`useLocalFileBrowser`), so the tree, tabs and open note
  follow them. A name that is not in the tree skips the step; a scene never
  guesses. A status is the note's own `status:` line, or its folder's front note
  (made when there is none), which is how anybody makes a project.
- **The homepage's folder pages read the visitor's copy** (`useLocalFolderLists`,
  handed to the console as `ConsoleData.folderLists`), so a projects folder
  draws the console's own List and Board, and a status set in a scene moves its
  row live. The homepage asks nothing of a device mirror or the server for them.
- **Framing is a line in the block**: `chat: side by side` (the default; above
  the workspace on a phone) or `chat: cut`, which fills the frame until the next
  `opens:`. A visitor can close the chat; the studio's stage cannot, since it is
  a recording.

Tests: `apps/mobile/__tests__/castChatGrammar.test.ts`, `castChat.test.ts`,
`castWorkspace.test.ts`, and `e2e/webkit/castChat.spec.ts`.
