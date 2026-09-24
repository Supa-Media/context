import { useCallback } from "react";
import { useFrame } from "../../app/AppFrame";
import { useKeymap } from "../../design/useKeymap";
import type { ConsoleNav } from "../ConsoleNavContext";
import type { Dialog } from "../files/Explorer";
import type { FileBrowser } from "../files/browser";
import { readFocus, scopeForFocus } from "../keyboardScope";
import { applyRowIntent, intentForRowCommand } from "../files/rowCommand";
import { topmost, type TreePick } from "../files/selection";
import { tabAt } from "../files/tabs";
import type { useTabs } from "../files/useTabs";

/* -------------------------------------------------------------------------- */

/**
 * The keyboard.
 *
 * One listener for the whole console, with the scope resolved **at the moment
 * a key arrives** rather than at render — see `keyboardScope.ts` for why a
 * `focusedRegion` state cannot work here.
 *
 * ## Every chord the menu prints, this answers
 *
 * That is the contract, and it was broken before this: the tree and editor
 * scopes were never passed, so thirty-three of the thirty-seven commands
 * resolved to nothing while the context menu cheerfully printed `F2`, `⌘D`,
 * `⌘⇧M`, `⌘C`, `⌘X`, `⌘⌫` and `⌘⇧⌫` beside its rows — and **⌘S did not save.**
 * `menu.ts`'s doc argues that routing shortcuts through `describeBinding` means
 * a printed chord is a real one; that guarantees the chord is in the table, not
 * that anything is listening. This is the listener.
 *
 * A command that lands somewhere with nothing to do returns `false`, which
 * leaves the browser's own behaviour alone — that is why `preventDefault` is
 * conditional on a `true` in the first place.
 */
export function Shortcuts({
  files,
  tabs,
  nav,
  onCloseTab,
  onDialog,
  picked,
  onPickSpent,
  onSearch,
  paletteOpen,
}: {
  files: FileBrowser;
  tabs: ReturnType<typeof useTabs>;
  /** ⌘[ and ⌘], over the same history the note's own `‹ ›` walk. */
  nav: ConsoleNav;
  /** ⌘W. Asks before discarding a draft, exactly as the × does. */
  onCloseTab: (path: string) => void;
  /** Raise one of the tree's dialogs — the same set the toolbar's `+` uses. */
  onDialog: (dialog: Dialog) => void;
  /** The tree's multi-selection, which a row chord acts on when there is one. */
  picked: TreePick;
  /** Put the pick down once a chord has acted on it. */
  onPickSpent: () => void;
  onSearch: () => void;
  paletteOpen: boolean;
}) {
  const frame = useFrame();

  useKeymap({
    scope: useCallback(() => scopeForFocus(readFocus(paletteOpen)), [paletteOpen]),
    onCommand: useCallback(
      (command) => {
        switch (command) {
          /* ---- frame ---------------------------------------------------- */
          case "palette":
          case "quickSwitcher":
            onSearch();
            return true;
          case "toggleExplorer":
            frame.toggleExplorer();
            return true;
          case "toggleFocus":
            frame.toggleFocus();
            return true;
          case "dismiss":
            // `keymap.ts` says Escape "closes whatever is open, wherever you
            // are", and until this the console answered for nothing but the
            // palette — so the one panel that is the only way off a pane could
            // be dismissed by a press or a scrim and not by the key everybody
            // tries. Returns whether there was anything to close, so an Escape
            // with no panel up still reaches the browser.
            return frame.closeOverlays();

          /* ---- the note ------------------------------------------------- */
          case "save":
            /*
              The one people try first, and it still works with autosave on:
              every editor lets somebody save *now* rather than in two seconds,
              and the press is the same conditional write the timer would have
              made.

              `error` as well as `dirty`, which it was not before. That is the
              state autosave deliberately does not retry from, so the keyboard
              has to be able to reach it — the same reason `saveButton` keeps
              the button pressable there. `conflict` is left out: a plain save
              would be checked against an etag somebody else has moved past and
              come straight back as the same refusal, and the answer to it is
              the resolver's three choices.
            */
            if (!files.canEdit) return false;
            if (files.editor.status !== "dirty" && files.editor.status !== "error") return false;
            files.save();
            return true;

          /* ---- tabs ----------------------------------------------------- */
          case "closeTab":
            if (tabs.state.activePath === null) return false;
            onCloseTab(tabs.state.activePath);
            return true;
          case "reopenTab":
            if (tabs.state.closed.length === 0) return false;
            tabs.reopen();
            return true;
          /* ---- where you have been -------------------------------------- */
          case "goBack":
          case "goForward": {
            /*
              `false` at the ends of the history, which is what lets the press
              reach the browser — on the web ⌘[ is its back chord too, and a
              console with nowhere of its own to go should not swallow it.
              The same answer the dimmed `‹ ›` give, through the same state.
            */
            const available = command === "goBack" ? nav.canBack : nav.canForward;
            if (!available) return false;
            if (command === "goBack") nav.back();
            else nav.forward();
            return true;
          }

          case "nextTab":
          case "prevTab": {
            const { tabs: open, activePath } = tabs.state;
            if (open.length < 2 || activePath === null) return false;
            const index = open.findIndex((tab) => tab.path === activePath);
            const step = command === "nextTab" ? 1 : -1;
            // Wraps, because a strip you can only walk to the end of makes you
            // reverse direction to reach the tab one place behind you.
            const next = open[(index + step + open.length) % open.length];
            tabs.activate(next.path);
            return true;
          }

          /* ---- the tree ------------------------------------------------- */
          case "newNote":
          case "newFolder":
          case "rename":
          case "duplicate":
          case "moveTo":
          case "copy":
          case "cut":
          case "paste":
          case "archive":
          case "deleteForever": {
            /*
              These used to return `false` under a comment saying "`Explorer`
              binds them itself". It binds no key at all — it has no keyboard
              handler of any kind — so every chord the row menu prints beside
              these ten was dead: `F2`, `⌘D`, `⌘⇧M`, `⌘C`, `⌘X`, `⌘V`, `⌘⌫`,
              `⌘⇧⌫`. `menu.ts` argues that routing a printed chord through
              `describeBinding` means it is a real one; that proves the chord is
              in the table, not that anything is listening. This is what listens.

              The dialog state is here rather than duplicated — the toolbar's
              `+` already raises `ExplorerDialogs` from this component, which is
              why `ExplorerDialogs` was split out of `Explorer` in the first
              place.

              A keystroke acts on the *selection*; the menu acts on the row
              under the pointer. `rowCommand.ts` owns what they must agree
              about, and answers `null` for a command with no target — which
              leaves the browser's own behaviour alone, as an unhandled command
              should.
            */
            const intent = intentForRowCommand(command, {
              canEdit: files.canEdit,
              selectedPath: files.selectedPath,
              listings: files.listings,
              clipboard: files.clipboard,
              picked: topmost(picked.paths, []),
            });
            if (intent === null) return false;
            const applied = applyRowIntent(intent, files, onDialog);
            if ("paths" in intent) onPickSpent();
            return applied;
          }

          default: {
            // ⌘1–⌘9. Written as a fall-through rather than nine cases.
            const index = (NUMBERED_TABS as readonly string[]).indexOf(command);
            if (index < 0) return false;
            const target = tabAt(tabs.state, index);
            if (target === null) return false;
            tabs.activate(target);
            return true;
          }
        }
      },
      /*
        `nav` belongs here rather than being left out as "stable enough": it is
        memoized on the history state, so it is the one dependency in this list
        that changes on every navigation — and a stale copy would answer ⌘[
        with the `canBack` of wherever somebody was two notes ago.
      */
      [files, tabs, nav, onCloseTab, onDialog, frame, onSearch, picked, onPickSpent],
    ),
  });

  return null;
}

/** ⌘1 … ⌘9, in order, so `tabAt` can be indexed straight off the command. */
const NUMBERED_TABS = [
  "tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7", "tab8", "tab9",
] as const;
