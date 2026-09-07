/**
 * What THIS build can actually do, asked rather than declared.
 *
 * `docs/decisions/desktop.md`: *"`version` gates the shape; `capabilities()`
 * gates the feature."* A web bundle published this afternoon lands on a shell
 * somebody installed in March, and the one thing no version number could have
 * predicted is whether macOS will hand *that binary* a loopback tap — an
 * unsigned build is refused one and a notarised build is not, at the same
 * bridge version, on the same machine.
 *
 * So the answer is computed here, from facts about the running process, and it
 * is a pure function precisely because the alternative is a boolean that can
 * only be checked by installing two builds on two versions of macOS.
 */

export interface SystemAudioInput {
  /** `process.platform`. */
  platform: string;
  /** `app.isPackaged` — false for `electron dist/main/index.js` in development. */
  packaged: boolean;
  /**
   * Whether **this build** was code-signed with the Developer ID certificate.
   *
   * `__CONTEXT_DESKTOP_SIGNED__`, the same build-time literal
   * `shouldArmUpdater` reads, and asked for the same reason: it is never
   * inferred from `packaged`, because an unsigned `.dmg` built by
   * `pnpm --filter @context/desktop package` on somebody's laptop is packaged
   * and unsigned, and macOS hands *that* build no loopback tap.
   */
  signed: boolean;
  /**
   * The Darwin kernel major from `os.release()` — `22` is macOS 13.
   *
   * Passed as a number rather than parsed here so the parse is the caller's one
   * line and this stays a table somebody can read.
   */
  darwinMajor: number;
  /**
   * What happened the last time something asked macOS for the tap, or `null`.
   *
   * `DesktopCaptureRecorder.degradedChannels()` is the only real answer there
   * is: there is no API that says "would this build be given a loopback
   * stream", so the probe *is* the attempt. Deliberately not persisted by the
   * caller — a signed build installed over an unsigned one would otherwise
   * inherit the old answer and never ask again.
   */
  probed: boolean | null;
}

/**
 * Whether this build should tell the page it can capture the machine's audio.
 *
 * Three refusals and one guess, in that order:
 *
 *  - **The probe wins whenever there has been one.** It is the only fact in the
 *    list; everything below it is inference about what macOS is likely to do.
 *  - **Not macOS, no tap.** `audio: "loopback"` is a ScreenCaptureKit binding.
 *    A Windows shell would need WASAPI loopback and a Linux one has no general
 *    answer, so both answer false and the UI already knows what to do with that.
 *  - **Not packaged and signed, no tap.** ScreenCaptureKit wants a hardened
 *    runtime, the audio-input entitlement and a notarised, code-signed app.
 *    Both, not either, and for the same reason `shouldArmUpdater` asks for
 *    both: an unsigned `.dmg` built on somebody's laptop is packaged and gets
 *    nothing, and a signed build run from a terminal in development is not
 *    packaged. What remains unproven above this is notarisation, which no
 *    process can ask itself about — that is what the probe is for.
 *  - **Older than macOS 13, no tap.** Electron's loopback path needs it.
 *
 * The direction of the residual is the one that matters: claiming a capability
 * this build turns out not to have is a system-audio switch on the glass of a
 * shell that cannot open one, which `docs/decisions/meetings.md` forbids by
 * name. It survives exactly one meeting — the first — and that meeting still
 * records the microphone and says in one sentence what it is not doing.
 */
export function systemAudioCapability(input: SystemAudioInput): boolean {
  if (input.probed !== null) return input.probed;
  if (input.platform !== "darwin") return false;
  if (!input.packaged || !input.signed) return false;
  return input.darwinMajor >= MACOS_13_DARWIN_MAJOR;
}

/** macOS 13 Ventura. Below it there is no system-audio path on macOS at all. */
export const MACOS_13_DARWIN_MAJOR = 22;

/** The kernel major from an `os.release()` string, or `0` when it is not one. */
export function darwinMajorFrom(release: string): number {
  const major = Number.parseInt(String(release).split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}
