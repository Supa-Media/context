import { useState } from "react";
import { Platform } from "react-native";
import { FrameIconButton } from "../../../app/AppFrame";
import { hasCast } from "../../../home/castPreview";
import { CastStudio } from "../../../studio/CastStudio";
import type { SaveSounds, SoundStorage } from "../../../studio/sounds/useStudioSounds";
import { setNoteProperty } from "../../../../../mcp/src/lists.js";
import type { FileBrowser } from "../../files/browser";
import { noteHeading } from "../../files/frontmatter";
import type { Presence } from "../../presence/usePresence";
import { SOUNDS_PROPERTY } from "../../../studio/sounds/castSounds";

/**
 * The play button beside the eye, for a note whose draft holds a cast block,
 * or nothing. Pressing it opens the cast studio over the console (Dev2,
 * 2026-09-29): the draft, unpublished and unsaved as it is, played through the
 * homepage's own player in phone, desktop and square frames, ready to record.
 * It used to open that player alone in a new tab; the studio's stage is that
 * same player (`features/studio/`). The stage is a web page in a frame, so
 * the button is on the web (and the desktop app) only.
 */
export function castPreviewButton(draft: string, path: string, saveSounds?: SaveSounds, soundStorage?: SoundStorage) {
  if (Platform.OS !== "web" || !hasCast(draft)) return null;
  return <CastPreviewButton draft={draft} path={path} saveSounds={saveSounds} soundStorage={soundStorage} />;
}

function CastPreviewButton({
  draft,
  path,
  saveSounds,
  soundStorage,
}: {
  draft: string;
  path: string;
  saveSounds?: SaveSounds;
  soundStorage?: SoundStorage;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FrameIconButton icon="play" label="Preview demo" onPress={() => setOpen(true)} testID="browse-cast-preview" />
      {open ? <CastStudio
          draft={draft}
          title={noteHeading(draft, path)}
          onClose={() => setOpen(false)}
          onSaveSounds={saveSounds}
          soundStorage={soundStorage}
        /> : null}
    </>
  );
}

/**
 * The studio's sound choices, written into the open note's `sounds:` line the
 * way the Properties panel writes a property: through the editor, against the
 * text the room holds, so it saves and merges like a keystroke. `undefined`
 * for somebody who cannot change the note: their studio still plays and
 * tunes sounds, and keeps nothing.
 */
export function soundsWriter(files: FileBrowser, presence: Presence | undefined): SaveSounds | undefined {
  if (!files.canEdit) return undefined;
  return (items) => {
    const shared = presence?.collaboration;
    const current = shared?.text ?? files.editor.draft;
    const changed = setNoteProperty(current, SOUNDS_PROPERTY, items);
    if ("error" in changed) return `That can’t be saved: ${changed.error ?? "it would not read back as written"}.`;
    if (changed.text === current) return null;
    if (shared !== undefined) shared.onVersionedChange(changed.text, shared.revision);
    else files.setDraft(changed.text);
    return null;
  };
}

/**
 * Uploaded sounds go where the note's images go: the workspace's own bucket,
 * named from their bytes, read back for the open note that names them
 * (`storeImage`/`loadImage`, which the server routes by the file's type).
 * Only somebody who can change the note may keep one.
 */
export function soundStorage(files: FileBrowser): SoundStorage {
  return { store: files.canEdit ? files.storeImage : undefined, load: files.loadImage };
}
