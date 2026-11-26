/**
 * The bot panel's contents, handed to the side panel through a slot of their own, so the page only hears when the
 * panel opens or closes and the panel follows every render of the Bots view (as `AreasView.tsx` does for an area).
 */

import { useSyncExternalStore } from "react";
import { AnyBotPanel, type AnyBotPanelProps } from "./LiveBotPanel";

type Held = Omit<AnyBotPanelProps, "width"> | null;

export function panelSlot() {
  let current: Held = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next: Held) => {
      current = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function PanelSlotView({ slot, width }: { slot: ReturnType<typeof panelSlot>; width: number }) {
  const props = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  return props === null ? null : <AnyBotPanel {...props} width={width} />;
}
