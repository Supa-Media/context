/**
 * The state `main()` shares, in one object rather than module-level `let`s.
 *
 * Every field here used to be a `let` at the top of `main/index.ts`, read and
 * reassigned by the functions inside `main()`. They are fields of one object
 * now, created once per launch by `createMainContext()`, so that the functions
 * which read them can live in modules of their own and still read the value
 * *at call time* — `ctx.consoleBridge` is rebuilt whenever the console window
 * is, and a function holding a copy of the one that existed when it was
 * created would push into a window that is gone.
 *
 * The comments below are the ones that sat on the `let`s, moved with them.
 */

import type { BrowserWindow } from "electron";
import type { DetectionUpdate } from "../core/detection/loop.ts";
import { IDLE_CONSENT } from "../core/consent/gate.ts";
import type { ConsentState } from "../core/consent/gate.ts";
import { emptyOutbox } from "../core/sync/outbox.ts";
import type { Outbox } from "../core/sync/outbox.ts";
import { createApprovalRoute } from "../core/shell/approval.ts";
import type { ApprovalRoute } from "../core/shell/approval.ts";
import { createApprovalHandover } from "../core/shell/autoGrant.ts";
import type { ApprovalHandover } from "../core/shell/autoGrant.ts";
import type { ConsoleBridge } from "./consoleBridge.ts";
import type { ConsoleMirror } from "./consoleMirror.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { DesktopSettings } from "../core/settings.ts";

export interface MainState {
  settings: DesktopSettings;
  outbox: Outbox;
  consent: ConsentState;
  lastUpdate: DetectionUpdate | null;
  missingPermissions: string[];
  /**
   * What the last capture found out about system audio, for the next meeting.
   *
   * `null` until something has tried: there is no API that answers "would macOS
   * give this build the loopback tap" without asking for it, so the probe is the
   * attempt and this is its answer. It is deliberately **not** persisted — a
   * signed build installed over an unsigned one would inherit the old answer and
   * never ask again.
   */
  systemAudioAvailable: boolean | null;
  connecting: boolean;
  /**
   * The console window and the bridge behind it, when this launch opened one.
   *
   * Both are `null` on a `CONTEXT_DESKTOP_UI=renderer` launch, which is still the
   * default, and every use of them is optional-chained for that reason rather
   * than guarded by the flag a second time.
   */
  consoleWindow: BrowserWindow | null;
  consoleBridge: ConsoleBridge | null;
  /**
   * The address this launch resolved the console to, once it has.
   *
   * Recorded rather than re-derived, because the bug it exists to expose was in
   * the *wiring* and not in `consoleUrl` itself: a signed build resolved
   * `http://localhost:8081` and showed a blank window, and a check that asks
   * `consoleUrl(process.env, app.isPackaged)` a second time would have agreed
   * with itself and reported nothing. This is what the window was actually
   * pointed at.
   */
  consoleAddress: string | null;
  /**
   * The offline mirror, and the authority on which origin is pinned.
   *
   * `null` until a console window is opened, and the bridge reads
   * `pinnedOrigin()` through a getter for it — a shell serving the mirror trusts
   * `app://console` *instead of* the live origin, never as well as it.
   */
  consoleMirror: ConsoleMirror | null;
  /**
   * Resolves once the console window's first navigation has settled — `true` for
   * `did-finish-load`, `false` for a main-frame `did-fail-load` (the mirror or
   * the failure page takes over from there, and this promise does not follow it
   * — that is `consoleMirror.awaitFallback()`'s job, awaited separately by
   * `--smoke-load` once this one resolves `false`).
   *
   * `null` on a launch that never opened a console window at all —
   * `CONTEXT_DESKTOP_UI=renderer`, or a `CONTEXT_DESKTOP_UI_URL` this app
   * refused — which `--smoke-load` reads as "there was nothing to wait for".
   */
  consoleLoadSettled: Promise<boolean> | null;
  /**
   * The one navigation this window makes that is neither the console nor the
   * mirror: the loopback address a connect in flight is listening on.
   *
   * One per launch and single, because there is one console window and
   * `connectThisMachine` already refuses to run twice over. It is `null` except
   * between pressing Connect and the grant coming back — `core/shell/approval.ts`
   * is the argument, and `test/approval.test.mjs` is the check.
   */
  readonly approval: ApprovalRoute;
  /**
   * The parked request this machine has handed to the page, while it holds one.
   *
   * One per launch and single for `approval`'s reason — one console window, one
   * connect at a time. `core/shell/autoGrant.ts` is the argument and
   * `test/autoGrant.test.mjs` is the check.
   */
  readonly handover: ApprovalHandover;
  connectError: string | null;
}

export type MainContext = MainState;

/** The state a launch starts in: the values the module-level `let`s held. */
export function createMainContext(): MainContext {
  return {
    settings: DEFAULT_SETTINGS,
    outbox: emptyOutbox(),
    consent: IDLE_CONSENT,
    lastUpdate: null,
    missingPermissions: [],
    systemAudioAvailable: null,
    connecting: false,
    consoleWindow: null,
    consoleBridge: null,
    consoleAddress: null,
    consoleMirror: null,
    consoleLoadSettled: null,
    approval: createApprovalRoute(),
    handover: createApprovalHandover(),
    connectError: null,
  };
}
