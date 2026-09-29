import { useSyncExternalStore } from "react";
import {
  currentJoinSlot,
  subscribeJoinSlots,
  type JoinSlot,
} from "../console/files/livePreview/joinSlot";

/** The open page's ```` ```join ```` box, or `null` when it has none. */
export function useJoinSlot(): JoinSlot | null {
  return useSyncExternalStore(subscribeJoinSlots, currentJoinSlot, () => null);
}
