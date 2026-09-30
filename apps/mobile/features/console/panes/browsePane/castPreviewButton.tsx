import { useState } from "react";
import { setCastPace, type CastPaceName } from "@context/shared";
import { useCustomEmoji } from "../../emoji/context";
import { Platform } from "react-native";
import { FrameIconButton } from "../../../app/AppFrame";
import { hasCast } from "../../../home/castPreview";
import { CastStudio } from "../../../studio/CastStudio";
import type { SaveSounds, SoundStorage } from "../../../studio/sounds/useStudioSounds";
import type { ReadScenePage } from "../../../studio/scenePages";
import { previewSlug } from "../../../home/castPreview";
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
export function castPreviewButton(
  draft: string,
  path: string,
  saveSounds?: SaveSounds,
  soundStorage?: SoundStorage,
  readPage?: ReadScenePage,
  savePace?: (pace: CastPaceName) => string | null,
) {
  if (Platform.OS !== "web" || !hasCast(draft)) return null;
  return (
    <CastPreviewButton
      draft={draft}
      path={path}
      saveSounds={saveSounds}
      soundStorage={soundStorage}
      readPage={readPage}
      savePace={savePace}
    />
  );
}

function CastPreviewButton({
  draft,
  path,
  saveSounds,
  soundStorage,
  readPage,
  savePace,
}: {
  draft: string;
  path: string;
  saveSounds?: SaveSounds;
  soundStorage?: SoundStorage;
  readPage?: ReadScenePage;
  savePace?: (pace: CastPaceName) => string | null;
}) {
  const [open, setOpen] = useState(false);
  // The workspace's own emoji, when the console has them to hand.
  const emoji = useCustomEmoji();
  return (
    <>
      <FrameIconButton icon="play" label="Preview demo" onPress={() => setOpen(true)} testID="browse-cast-preview" />
      {open ? <CastStudio
          draft={draft}
          title={noteHeading(draft, path)}
          onClose={() => setOpen(false)}
          onSaveSounds={saveSounds}
          soundStorage={soundStorage}
          readPage={readPage}
          onSavePace={savePace}
          loadEmoji={emoji === null ? undefined : (name) => emoji.load(name)}
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
  const write = noteWriter(files, presence);
  if (write === undefined) return undefined;
  return (items) =>
    write((current) => {
      const changed = setNoteProperty(current, SOUNDS_PROPERTY, items);
      return "error" in changed ? `That can’t be saved: ${changed.error ?? "it would not read back as written"}.` : { text: changed.text };
    });
}

/** The studio's pace, written as the scene's `pace:` line, the same way. */
export function paceWriter(files: FileBrowser, presence: Presence | undefined): ((pace: CastPaceName) => string | null) | undefined {
  const write = noteWriter(files, presence);
  return write === undefined ? undefined : (pace) => write((current) => ({ text: setCastPace(current, pace) }));
}

/** A change to the open note, through the room when there is one; why not, or `null`. */
function noteWriter(
  files: FileBrowser,
  presence: Presence | undefined,
): ((change: (current: string) => { text: string } | string) => string | null) | undefined {
  if (!files.canEdit) return undefined;
  return (change) => {
    const shared = presence?.collaboration;
    const current = shared?.text ?? files.editor.draft;
    const changed = change(current);
    if (typeof changed === "string") return changed;
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

/**
 * The page a scene opens, found beside the scene's own note: `opens: pricing`
 * is `pricing.md` (or `02-pricing.md`) in the same folder, or a path from it.
 * Read as the person reading this note can read it, and nothing else.
 */
export function scenePageReader(files: FileBrowser, notePath: string): ReadScenePage {
  const folder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  return async (name) => {
    const wanted = previewSlug(name.slice(name.lastIndexOf("/") + 1));
    const within = name.includes("/") ? name.slice(0, name.lastIndexOf("/")).replace(/^\/+|\/+$/g, "") : "";
    const where = within === "" ? folder : folder === "" ? within : `${folder}/${within}`;
    if (wanted === "" || where.split("/").includes("..")) return null;
    const listed = (files.listings[where]?.entries ?? [])
      .filter((entry) => entry.kind === "file" && entry.path.endsWith(".md") && entry.path !== notePath)
      .find((entry) => previewSlug(entry.name.replace(/^\d{2}-/, "")) === wanted)?.path;
    const path = listed ?? `${where === "" ? "" : `${where}/`}${wanted}.md`;
    if (path === notePath) return null;
    const read = await files.readRaw(path);
    return read === null ? null : { name, title: noteHeading(read.text, path), markdown: read.text };
  };
}
