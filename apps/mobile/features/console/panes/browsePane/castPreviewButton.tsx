import { useState } from "react";
import { Platform } from "react-native";
import { FrameIconButton } from "../../../app/AppFrame";
import { hasCast } from "../../../home/castPreview";
import { CastStudio } from "../../../studio/CastStudio";
import { noteHeading } from "../../files/frontmatter";

/**
 * The play button beside the eye, for a note whose draft holds a cast block,
 * or nothing. Pressing it opens the cast studio over the console (Dev2,
 * 2026-09-29): the draft, unpublished and unsaved as it is, played through the
 * homepage's own player in phone, desktop and square frames, ready to record.
 * It used to open that player alone in a new tab; the studio's stage is that
 * same player (`features/studio/`). The stage is a web page in a frame, so
 * the button is on the web (and the desktop app) only.
 */
export function castPreviewButton(draft: string, path: string) {
  if (Platform.OS !== "web" || !hasCast(draft)) return null;
  return <CastPreviewButton draft={draft} path={path} />;
}

function CastPreviewButton({ draft, path }: { draft: string; path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FrameIconButton icon="play" label="Preview demo" onPress={() => setOpen(true)} testID="browse-cast-preview" />
      {open ? <CastStudio draft={draft} title={noteHeading(draft, path)} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
