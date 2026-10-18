import { Menu } from "../../../design/components/Menu";
import { runMenuAction, type ActionContext } from "../../files/actions";
import { HoldMenu } from "../../files/HoldMenu";
import { holdLayout, holdPreview } from "../../files/holdLayout";
import type { TreeRow } from "../../files/tree";
import type { HomeNote } from "../../home/homeModel";
import type { FolderMenuState } from "./folderMenuState";

/**
 * The folder listing's open menu: the sheet or popover as before, or, for a
 * press and hold on a phone row, Apple Notes' lifted preview and short menu
 * (the owner's board, 2026-10-16). Its More becomes the sheet again, holding
 * what the short menu left out.
 */
export function ListingMenu({
  menu,
  setMenu,
  actions,
  notes,
  folders,
  holdSelect,
}: {
  menu: FolderMenuState;
  setMenu: (menu: FolderMenuState) => void;
  actions: ActionContext;
  notes: readonly HomeNote[];
  folders: readonly string[];
  holdSelect: (row: TreeRow) => (() => void) | undefined;
}) {
  if (menu === null) return null;
  const target = menu.target;
  if (menu.hold === true && target.kind === "row" && (target.row.kind === "file" || target.row.kind === "folder")) {
    const row = target.row;
    const layout = holdLayout(menu.items);
    const selectMany = holdSelect(row);
    return (
      <HoldMenu
        preview={holdPreview({ kind: row.kind === "folder" ? "folder" : "file", path: row.path, name: row.name }, notes, folders, Date.now())}
        layout={layout}
        onOpen={() => runMenuAction("open", target, actions)}
        {...(selectMany === undefined ? {} : { onSelectMany: selectMany })}
        onRun={(id) => runMenuAction(id, target, actions)}
        {...(layout.more.length === 0
          ? {}
          : { onMore: () => setMenu({ ...menu, items: layout.more, hold: false }) })}
        onDismiss={() => setMenu(null)}
      />
    );
  }
  return (
    <Menu
      items={menu.items}
      anchor={menu.anchor}
      title={menu.title}
      onSelect={(id) => {
        setMenu(null);
        runMenuAction(id, target, actions);
      }}
      onDismiss={() => setMenu(null)}
    />
  );
}
