import { useMemo } from "react";
import { installE2EEncryptionFixture } from "./e2eEncryptionFixture";
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
 *
 * `encryptionWriters` is the one exception to "touches nothing else,
 * persistence included" — see `e2eEncryptionFixture.ts`'s own header for why
 * the passphrase flows need a write path that actually persists, and why that
 * does not weaken the rule for everything else here.
 */
export function useE2EFixtureConsoleData(): ConsoleData {
  const demo = useDemoConsoleData();
  // Once per mount — a real `page.reload()` is a fresh mount and re-seeds
  // from `localStorage`; nothing within one page load needs a second call.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const encryptionWriters = useMemo(() => installE2EEncryptionFixture(), []);
  return {
    ...demo,
    files: { ...demo.files, canEdit: true, canShare: true, canSetVisibility: true },
    encryptionWriters,
  };
}
