/**
 * `electron-updater`, wired to the policy in `core/update/policy.ts`.
 *
 * Every decision worth arguing about is in that file and is checked there
 * without Electron. What is left here is turning `autoUpdater`'s events into
 * calls to `transition()`, and refusing every `quitAndInstall()` this app makes
 * unless `mayInstall()` says yes — which is the one rule
 * `docs/decisions/desktop.md` states in as many words: **an update must never
 * interrupt a meeting.**
 */

import { autoUpdater } from "electron-updater";
import {
  mayInstall,
  shouldArmUpdater,
  shouldCheckForUpdate,
  transition,
} from "../core/update/policy.ts";
import type { UpdateEvent, UpdateState } from "../core/update/policy.ts";

/** How often the scheduler is polled. Short, because `shouldCheckForUpdate` decides the rest. */
const POLL_INTERVAL_MS = 60_000;

export interface DesktopUpdaterDeps {
  packaged: boolean;
  /** Baked in at bundle time by `scripts/build.mjs` — see its header. */
  signed: boolean;
  /** Read fresh on every `install()` call. `MeetingController.recording`. */
  capturing: () => boolean;
  onStateChange?: (state: UpdateState) => void;
  log: (message: string) => void;
  now?: () => number;
}

export class DesktopUpdater {
  #deps: DesktopUpdaterDeps;
  #state: UpdateState = "idle";
  #armed: boolean;
  #launchedAtMs: number;
  #lastCheckedAtMs: number | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: DesktopUpdaterDeps) {
    this.#deps = deps;
    this.#armed = shouldArmUpdater({ packaged: deps.packaged, signed: deps.signed });
    this.#launchedAtMs = (deps.now ?? Date.now)();
  }

  get state(): UpdateState {
    return this.#state;
  }

  get armed(): boolean {
    return this.#armed;
  }

  /**
   * Wire the library's events and start polling. A no-op on a build that is
   * not packaged and signed — the tray says so rather than silently doing
   * nothing, the same honesty this app already gives an unsigned dmg's system
   * audio.
   */
  start(): void {
    if (!this.#armed) {
      this.#deps.log(
        "[update] not armed — this build is unpackaged or unsigned, and Squirrel.Mac has nothing to verify it against.",
      );
      return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => this.#move({ type: "check-started" }));
    autoUpdater.on("update-not-available", () => this.#move({ type: "no-update-found" }));
    autoUpdater.on("error", (error) => {
      // Never the URL a release lives at, and never a token — `error.message`
      // from `electron-updater` is the GitHub API's own text, which does not
      // carry either for a public repository's public releases.
      this.#deps.log(`[update] check failed: ${error.message}`);
      this.#move({ type: "check-failed" });
    });
    autoUpdater.on("update-available", (info) => {
      this.#deps.log(`[update] ${info.version} is available — downloading.`);
      this.#move({ type: "update-available" });
    });
    autoUpdater.on("update-downloaded", (info) => {
      const capturing = this.#deps.capturing();
      this.#deps.log(
        `[update] ${info.version} downloaded${capturing ? " — a meeting is recording, so the install is deferred until it ends" : " — ready to install"}.`,
      );
      this.#move({ type: "update-downloaded", capturing });
    });

    this.#maybeCheck();
    this.#timer = setInterval(() => this.#maybeCheck(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** The meeting ended and its note was written — release a deferred install. */
  captureEnded(): void {
    this.#move({ type: "capture-ended" });
  }

  /**
   * The tray's "Restart to update" command.
   *
   * Refuses via `mayInstall`, which re-reads `capturing` rather than trusting
   * how the app reached `state` — see that function's own header for why.
   * Returns whether it actually asked Electron to quit, so the caller can
   * decide whether to say anything.
   */
  install(): boolean {
    if (!mayInstall(this.#state, this.#deps.capturing())) return false;
    autoUpdater.quitAndInstall();
    return true;
  }

  #move(event: UpdateEvent): void {
    this.#state = transition(this.#state, event);
    this.#deps.onStateChange?.(this.#state);
  }

  #maybeCheck(): void {
    const now = (this.#deps.now ?? Date.now)();
    if (
      !shouldCheckForUpdate({
        now,
        launchedAtMs: this.#launchedAtMs,
        lastCheckedAtMs: this.#lastCheckedAtMs,
      })
    ) {
      return;
    }
    this.#lastCheckedAtMs = now;
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      this.#deps.log(
        `[update] checkForUpdates threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
