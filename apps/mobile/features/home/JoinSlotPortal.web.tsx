import { useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { JoinSlot } from "../console/files/livePreview/joinSlot";

/**
 * Draws the homepage's join card inside the page's ```` ```join ```` box, so
 * the email field sits where the page put it (Dev2, 2026-09-29: "join the
 * waitlist" inline, as the artboard showed it). The box's own label, which
 * says what goes there on a surface that does not fill it, is hidden while
 * the card is in it.
 */
export function JoinSlotPortal({ slot, children }: { slot: JoinSlot; children: ReactNode }) {
  useLayoutEffect(() => {
    const shown = slot.label.style.display;
    slot.label.style.display = "none";
    return () => {
      slot.label.style.display = shown;
    };
  }, [slot]);
  return createPortal(children, slot.box);
}
