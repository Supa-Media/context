import { useDemoConsoleData } from "./useDemoConsoleData";
import type { ConsoleData } from "./types";

/**
 * The demo console, made editable in memory, for `app/e2e-fixture.tsx` alone.
 *
 * The landing page's `useDemoConsoleData` is deliberately read-only — a
 * visitor is never offered a control that would lie, see that file's header —
 * and one of the five WebKit cases this fixture exists for needs the opposite:
 * a checkbox only toggles when `EditorState.readOnly` is false, which
 * `editability()` sets from `canEdit`. So this flips the same three
 * capability flags `apps/mobile/scripts/design-shots.ts`'s `mockOwner` flips
 * for the same reason, in the same place — `files.canEdit`, `canShare`,
 * `canSetVisibility` — and touches nothing else. `save`, `share`, `destroy`
 * and every other mutating method on `files` stay the demo's no-ops: this
 * makes typing and the checkbox real, not persistence.
 *
 * Nothing here is reachable from the product. See `app/e2e-fixture.tsx` for
 * the gate.
 */
export function useE2EFixtureConsoleData(): ConsoleData {
  const demo = useDemoConsoleData();
  return {
    ...demo,
    files: { ...demo.files, canEdit: true, canShare: true, canSetVisibility: true },
  };
}
