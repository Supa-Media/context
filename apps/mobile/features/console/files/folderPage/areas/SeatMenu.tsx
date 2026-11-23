/**
 * The seat menu on native: always the sheet, with the seat's head and how to
 * reach its holder above the actions. Web chooses between this and a popover
 * in `SeatMenu.web.tsx`.
 */

import { Menu } from "../../../../design/components/Menu";
import { writeClipboard } from "../../../../design/clipboard";
import { SeatMenuHead, type SeatMenuId, type SeatMenuModel } from "./seatMenuParts";

export interface SeatMenuProps {
  model: SeatMenuModel;
  anchor?: { x: number; y: number };
  onSelect: (id: SeatMenuId) => void;
  onDismiss: () => void;
}

export function SeatMenu({ model, onSelect, onDismiss }: SeatMenuProps) {
  const items = [...model.items];
  return (
    <Menu<SeatMenuId>
      items={items}
      sheet={{ items, header: <SeatMenuHead model={model} touch onCopy={(text) => void writeClipboard(text)} /> }}
      onSelect={onSelect}
      onDismiss={onDismiss}
    />
  );
}
