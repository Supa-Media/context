import type { ReactNode } from "react";
import type { JoinSlot } from "../console/files/livePreview/joinSlot";

/**
 * Native has no homepage, and its editor runs in a web view this tree cannot
 * portal into, so the card stays above the note there (`JoinSlotPortal.web`).
 */
export function JoinSlotPortal(_props: { slot: JoinSlot; children: ReactNode }) {
  return null;
}
