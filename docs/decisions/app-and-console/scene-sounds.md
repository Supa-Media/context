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
