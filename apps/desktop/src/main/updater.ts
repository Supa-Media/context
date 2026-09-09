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

import updaterPackage from "electron-updater";
import {
  mayInstall,
  shouldArmUpdater,
  shouldCheckForUpdate,
  transition,
} from "../core/update/policy.ts";
import type { UpdateEvent, UpdateState } from "../core/update/policy.ts";

/** How often the scheduler is polled. Short, because `shouldCheckForUpdate` decides the rest. */
const POLL_INTERVAL_MS = 60_000;
const MANUAL_CHECK_TIMEOUT_MS = 120_000;

export type ManualUpdateCheckOutcome =
  | { type: "not-started" }
  | { type: "unarmed" }
  | { type: "checking" }
  | { type: "no-update" }
  | { type: "downloaded"; version: string | null; deferred: boolean }
  | { type: "error" };

export type ManualUpdateCheck =
  | { started: false; outcome: ManualUpdateCheckOutcome }
  | { started: true; outcome: Promise<ManualUpdateCheckOutcome> };

export interface DesktopAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "checking-for-update", listener: () => void): void;
  on(event: "update-not-available", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "update-available", listener: (info: { version: string }) => void): void;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface DesktopUpdaterDeps {
  packaged: boolean;
  /** Baked in at bundle time by `scripts/build.mjs` — see its header. */
  signed: boolean;
  /** Read fresh on every `install()` call. `MeetingController.recording`. */
  capturing: () => boolean;
  onStateChange?: (state: UpdateState) => void;
  log: (message: string) => void;
  now?: () => number;
  updater?: DesktopAutoUpdater;
}

export class DesktopUpdater {
  #deps: DesktopUpdaterDeps;
  #updater: DesktopAutoUpdater;
  #state: UpdateState = "idle";
  #armed: boolean;
  #started = false;
  #launchedAtMs: number;
  #lastCheckedAtMs: number | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #manualCheckPromise: Promise<ManualUpdateCheckOutcome> | null = null;
  #manualCheckResolve: ((outcome: ManualUpdateCheckOutcome) => void) | null = null;
  #manualCheckTimer: ReturnType<typeof setTimeout> | null = null;
  #downloadedVersion: string | null = null;

  constructor(deps: DesktopUpdaterDeps) {
    this.#deps = deps;
    this.#updater = deps.updater ?? defaultAutoUpdater();
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
      this.#started = true;
      this.#deps.log(
        "[update] not armed — this build is unpackaged or unsigned, and Squirrel.Mac has nothing to verify it against.",
      );
      return;
    }

    this.#updater.autoDownload = true;
    this.#updater.autoInstallOnAppQuit = true;

    this.#updater.on("checking-for-update", () => this.#move({ type: "check-started" }));
    this.#updater.on("update-not-available", () => {
      this.#move({ type: "no-update-found" });
      this.#finishManualCheck({ type: "no-update" });
    });
    this.#updater.on("error", (error) => {
      // Never echo the raw updater error. The library may include a request URL
      // or a proxy's response text, and logs are user-visible in crash reports.
      this.#deps.log(`[update] check failed: ${safeUpdaterError(error)}`);
      this.#move({ type: "check-failed" });
      this.#finishManualCheck({ type: "error" });
    });
    this.#updater.on("update-available", (info) => {
      this.#deps.log(`[update] ${info.version} is available — downloading.`);
      this.#move({ type: "update-available" });
    });
    this.#updater.on("update-downloaded", (info) => {
      const capturing = this.#deps.capturing();
      this.#downloadedVersion = info.version;
      this.#deps.log(
        `[update] ${info.version} downloaded${capturing ? " — a meeting is recording, so the install is deferred until it ends" : " — ready to install"}.`,
      );
      this.#move({ type: "update-downloaded", capturing });
      this.#finishManualCheck({ type: "downloaded", version: info.version, deferred: capturing });
    });

    this.#started = true;
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
    this.#updater.quitAndInstall();
    return true;
  }

  /**
   * A human asked from the macOS application menu. This bypasses the six-hour
   * scheduler, but not the arming rules or the install guard.
   */
  checkNow(): ManualUpdateCheck {
    if (!this.#started) {
      this.#deps.log("[update] manual check refused — updater startup has not finished yet.");
      return { started: false, outcome: { type: "not-started" } };
    }
    if (!this.#armed) {
      this.#deps.log(
        "[update] manual check refused — this build is unpackaged or unsigned, and Squirrel.Mac has nothing to verify it against.",
      );
      return { started: false, outcome: { type: "unarmed" } };
    }
    if (this.#state === "checking" || this.#state === "available") {
      this.#deps.log("[update] manual check ignored — an update check is already running.");
      return { started: false, outcome: { type: "checking" } };
    }
    if (this.#state === "ready" || this.#state === "deferred-for-recording") {
      this.#deps.log("[update] manual check ignored — an update is already downloaded.");
      return {
        started: false,
        outcome: {
          type: "downloaded",
          version: this.#downloadedVersion,
          deferred: this.#state === "deferred-for-recording" || this.#deps.capturing(),
        },
      };
    }
    this.#lastCheckedAtMs = (this.#deps.now ?? Date.now)();
    this.#manualCheckPromise = new Promise<ManualUpdateCheckOutcome>((resolve) => {
      this.#manualCheckResolve = resolve;
    });
    this.#manualCheckTimer = setTimeout(() => {
      this.#deps.log("[update] manual check timed out before the updater reported a result.");
      this.#move({ type: "check-failed" });
      this.#finishManualCheck({ type: "error" });
    }, MANUAL_CHECK_TIMEOUT_MS);
    this.#move({ type: "check-started" });
    this.#updater.checkForUpdates().catch((error: unknown) => {
      this.#deps.log(
        `[update] manual checkForUpdates threw: ${safeUpdaterError(error)}`,
      );
      this.#move({ type: "check-failed" });
      this.#finishManualCheck({ type: "error" });
    });
    return { started: true, outcome: this.#manualCheckPromise };
  }

  #move(event: UpdateEvent): void {
    this.#state = transition(this.#state, event);
    this.#deps.onStateChange?.(this.#state);
  }

  #finishManualCheck(outcome: ManualUpdateCheckOutcome): void {
    const resolve = this.#manualCheckResolve;
    if (resolve === null) return;
    if (this.#manualCheckTimer) clearTimeout(this.#manualCheckTimer);
    this.#manualCheckTimer = null;
    this.#manualCheckResolve = null;
    this.#manualCheckPromise = null;
    resolve(outcome);
  }

  #maybeCheck(): void {
    if (this.#state !== "idle") return;
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
    this.#move({ type: "check-started" });
    this.#updater.checkForUpdates().catch((error: unknown) => {
      this.#deps.log(
        `[update] checkForUpdates threw: ${safeUpdaterError(error)}`,
      );
      this.#move({ type: "check-failed" });
    });
  }
}

function defaultAutoUpdater(): DesktopAutoUpdater {
  return (updaterPackage as { autoUpdater: DesktopAutoUpdater }).autoUpdater;
}

function safeUpdaterError(error: unknown): string {
  if (error instanceof Error) {
    const code = codeOf(error);
    const name = nameOf(error.name);
    return code === null ? name : `${name} (${code})`;
  }
  const code = codeOf(error);
  return code === null ? "unknown error" : `unknown error (${code})`;
}

function nameOf(name: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : "Error";
}

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
}
