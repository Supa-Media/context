import { FrameIconButton } from "../../../app/AppFrame";
import {
  browserStorage,
  castPreviewHref,
  castPreviewSnapshot,
  hasCast,
  stashCastPreview,
} from "../../../home/castPreview";
import { noteHeading } from "../../files/frontmatter";

/**
 * The play button beside the eye, for a note whose draft holds a cast block,
 * or nothing. Pressing it plays the draft, unpublished and unsaved as it is,
 * through the homepage's own player in a new tab.
 */
export function castPreviewButton(draft: string, path: string) {
  if (!hasCast(draft)) return null;
  return (
    <FrameIconButton
      icon="play"
      label="Preview demo"
      onPress={() => openCastPreview(draft, path)}
      testID="browse-cast-preview"
    />
  );
}

function openCastPreview(draft: string, path: string) {
  const snapshot = castPreviewSnapshot(draft, noteHeading(draft, path), "Preview");
  const nonce = stashCastPreview(browserStorage(), snapshot);
  if (nonce === null) return;
  window.open(castPreviewHref(nonce), "_blank", "noopener");
}
