/**
 * Images in a note: the row, the selected image, its handles and its bar.
 *
 * One consecutive slice of `livePreviewStyles`, moved out of `livePreview.ts`
 * verbatim and in its original order; `../../livePreview.ts` joins the slices
 * back into the identical string. Order matters to the cascade, so a rule is
 * never moved between slices.
 */
export const imageStyles = `
/*
  IMAGES IN A NOTE — the row, the selected image, and its bar.

  Two things here are not cosmetic. The controls appear on the SELECTED image
  only, because a picture wearing permanent furniture reads as a form control
  rather than as a picture; and they are real buttons, so focus-visible keeps
  them reachable without a pointer. The image is painted on the code wash rather
  than on nothing, so a PNG with transparency has a ground in dark mode — an
  image keeps its own background here, the same argument previewDocument makes.
*/
.cm-lp-images {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin: 10px 0;
  position: relative;
}
.cm-lp-image {
  position: relative;
  margin: 0;
  max-width: 100%;
  min-width: 96px;
  flex: 0 1 auto;
}
/*
  THE CURSORS ARE THE INSTRUCTIONS.

  Over a writable image the pointer says "you can pick this up" — grab, and
  grabbing while it is moving. Over the side handles it says "you can pull this
  wider". Nothing about the picture says "type here", because you cannot.
*/
.cm-lp-image-live { cursor: grab; }
.cm-lp-image-moving { cursor: grabbing; opacity: 0.5; }
.cm-lp-image-img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 8px;
  background: var(--lp-code-bg);
}
/* A hairline on hover: enough to say the picture is a thing, not a decoration. */
.cm-lp-image-live:hover .cm-lp-image-img {
  outline: 1px solid var(--lp-line-strong);
  outline-offset: 3px;
}
.cm-lp-image-on .cm-lp-image-img,
.cm-lp-image-live.cm-lp-image-on:hover .cm-lp-image-img {
  outline: 2px solid var(--lp-link);
  outline-offset: 3px;
}
/*
  The handles. The two side bars are on every writable image and appear under
  the pointer, because resizing is the commonest thing anybody does to a picture
  and it should not need a click first; the corners belong to the selected one.
*/
.cm-lp-image-handle {
  position: absolute;
  padding: 0;
  border: 0;
  background: var(--lp-link);
  opacity: 0;
  touch-action: none;
}
.cm-lp-image-handle-w,
.cm-lp-image-handle-e {
  top: calc(50% - 17px);
  width: 6px;
  height: 34px;
  border-radius: 3px;
  cursor: ew-resize;
}
.cm-lp-image-handle-w { left: -5px; }
.cm-lp-image-handle-e { right: -5px; }
.cm-lp-image-handle-nw,
.cm-lp-image-handle-ne,
.cm-lp-image-handle-sw,
.cm-lp-image-handle-se {
  width: 11px;
  height: 11px;
  border-radius: 3px;
}
.cm-lp-image-handle-nw { left: -8px; top: -8px; cursor: nwse-resize; }
.cm-lp-image-handle-ne { right: -8px; top: -8px; cursor: nesw-resize; }
.cm-lp-image-handle-sw { left: -8px; bottom: -8px; cursor: nesw-resize; }
.cm-lp-image-handle-se { right: -8px; bottom: -8px; cursor: nwse-resize; }
.cm-lp-image-live:hover .cm-lp-image-handle,
.cm-lp-image-on .cm-lp-image-handle,
.cm-lp-image-handle:focus-visible {
  opacity: 1;
}
/* A handle under a moving image would be a target chasing the pointer. */
.cm-lp-image-moving .cm-lp-image-handle { opacity: 0; }
.cm-lp-image-badge {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 7px;
  border-radius: 5px;
  font-family: var(--lp-mono);
  font-size: 11px;
  color: var(--lp-content);
  background: var(--lp-code-bg);
}
/*
  The bar floats above the image it belongs to, which is where the hand already
  is. It is absolutely positioned so it cannot change the row's height and make
  the note jump as an image is selected and deselected.
*/
.cm-lp-image-bar {
  position: absolute;
  left: 0;
  bottom: calc(100% + 12px);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px 6px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 9px;
  background: var(--lp-code-bg);
  white-space: nowrap;
}
.cm-lp-image-chip,
.cm-lp-image-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--lp-muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.cm-lp-image-chip-on,
.cm-lp-image-tool-on {
  background: var(--lp-link);
  color: var(--lp-code-bg);
  font-weight: 600;
}
.cm-lp-image-tool-text {
  color: var(--lp-content);
}
.cm-lp-image-remove {
  color: var(--lp-heading);
}
.cm-lp-image-divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--lp-line-strong);
}
/* Alt text, in a field that opens under the bar and closes when it is done. */
.cm-lp-image-alt {
  position: absolute;
  left: 0;
  top: calc(100% + 10px);
  z-index: 2;
  width: min(420px, 100%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 9px;
  background: var(--lp-code-bg);
}
.cm-lp-image-alt-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lp-muted);
}
.cm-lp-image-alt-field {
  font-family: inherit;
  font-size: 13px;
  color: var(--lp-content);
  background: transparent;
  border: 1px solid var(--lp-line-strong);
  border-radius: 7px;
  padding: 8px 10px;
}
.cm-lp-image-alt-hint {
  font-size: 12px;
  line-height: 1.45;
  color: var(--lp-muted);
}
/*
  Where the line will land. Drawn in the scroller rather than in the row,
  because the drop can be anywhere in the note and a caret parented to the image
  would be clipped by it.
*/
.cm-lp-image-caret {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--lp-link);
  pointer-events: none;
}
.cm-lp-image-missing {
  display: block;
  font-family: var(--lp-mono);
  font-size: 0.85em;
  color: var(--lp-muted);
  padding: 6px 0;
}
`;
