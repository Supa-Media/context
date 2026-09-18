/**
 * WHETHER THE CONSOLE RESERVES A BAND FOR THE SHELL'S TRAFFIC LIGHTS.
 *
 * `docs/decisions/desktop.md`, "The console reserves the space", is the
 * argument. The defect: the desktop shell's console window is frameless with
 * inset traffic lights (`titleBarStyle: "hiddenInset"`), and the hosted page
 * draws from `x: 0` — so the close/minimise/zoom buttons sit on top of the
 * console's own top-left content (the active-context chip). The fix is not a
 * shell-side inset the page never sees: **the page reserves the space, the
 * shell places the buttons in it**, and both read the same number from
 * `@context/desktop-bridge`'s `SHELL_TITLE_BAND_PX`.
 *
 * A pure function rather than logic inside `ShellTitleBand.tsx`, for the
 * reason `apps/mobile/app/(app)/console/_layout.tsx` already states about
 * `files/scope.ts`: *"in a sabotage sweep of this codebase, every guard
 * written as a pure module held and every guard written inside a component did
 * not."* This one composes a platform check with a value read off a bridge
 * that is not this bundle's to trust — exactly the shape that rots into "any
 * shell is a Mac" the first time somebody tests it by eye instead of by name.
 *
 * ## Why `platformOS` and `shellPlatform` are two plain strings
 *
 * Not `Platform.OS` and not a `DesktopBridge` read inside this function: a
 * test that wants "no bridge at all" or "a Windows shell" should not have to
 * mock `react-native`'s `Platform` module or construct a whole fake bridge to
 * ask this one question. `ShellTitleBand.tsx` is the only caller that reads
 * either global, and it reads them in exactly the shape this function wants.
 */
export function shouldShowShellTitleBand(
  platformOS: string,
  shellPlatform: string | null | undefined,
): boolean {
  // Desktop is the only shell there is (`docs/decisions/desktop.md`: "macos
  // is the only one built"), and it hosts the app as a **web** page — there is
  // no native build of the app that runs *inside* the shell, so a phone or a
  // tablet asking this question is never inside it. `Platform.OS === "web"`
  // is therefore both halves of "are we being hosted by something that could
  // answer `shellPlatform` at all", stated once rather than assumed by a
  // caller that forgot to check.
  if (platformOS !== "web") return false;
  return shellPlatform === "macos";
}

/**
 * How many pixels the shell's traffic lights need reserved at the top.
 *
 * The same rule as `shouldShowShellTitleBand`, as a number, because the band
 * is not the only thing that has to know it. **Two other places pay it, and
 * both were defects until they did:**
 *
 *  - `AppFrame` is `100dvh` tall (`design/css.ts`), and it is drawn *below*
 *    the band — so the frame hung `SHELL_TITLE_BAND_PX` past the bottom of the
 *    window and the console's footer row was clipped by exactly the band's
 *    height. The frame is one viewport *minus the band*.
 *  - `Overlay` draws settings in a `Modal`, which is its own root view on
 *    every platform — nothing above it, band included, pushes it down. It
 *    opened at `y: 0` with the traffic lights on top of its own *Notes*
 *    control, which is the report this exists for: *"some pages dont take the
 *    streetlights in consideration"*.
 *
 * A number rather than a boolean at the call sites so neither of them
 * re-states `38`; the constant stays `@context/desktop-bridge`'s to change.
 */
export function shellTitleBandPx(
  platformOS: string,
  shellPlatform: string | null | undefined,
  bandPx: number,
): number {
  return shouldShowShellTitleBand(platformOS, shellPlatform) ? bandPx : 0;
}

/**
 * Whether the *root* band draws, given that a route below it may have taken
 * the job.
 *
 * The platform gate above, and then one more question: has anything on screen
 * said it holds the buttons itself? `topChrome.ts` is the handshake and its
 * header is the argument; this is the half of it that is a rule rather than a
 * store, here rather than inside the component for the reason stated at the
 * top of this file.
 *
 * **Order matters, and only one way round is safe.** A route publishing "I
 * hold them" on a platform that has no buttons at all must not be able to
 * suppress anything, because there is nothing to suppress and the flag is the
 * frame's opinion about a shell it may not be inside. So the platform gate is
 * asked first and the flag can only ever take a band *away* — never put one
 * where `shouldShowShellTitleBand` said there is none.
 */
export function shellBandDraws(
  platformOS: string,
  shellPlatform: string | null | undefined,
  chromeHoldsLights: boolean,
): boolean {
  if (!shouldShowShellTitleBand(platformOS, shellPlatform)) return false;
  return !chromeHoldsLights;
}

/**
 * How much room a bar holding the buttons itself owes at its leading edge.
 *
 * Zero unless this really is a Mac inside the shell *and* the caller is the
 * chrome that took the job — a bar that pays 84pt of leading inset in an
 * ordinary browser tab is 84pt of nothing, and that is the failure this
 * function exists to make impossible to write by hand at the call site.
 *
 * The same shape as `shellTitleBandPx` above, and for the same reason: the
 * constant stays `@context/desktop-bridge`'s to change, and the rule stays
 * testable without a bridge, a `Platform` mock or a rendered tree.
 */
export function shellLightsLeadPx(
  platformOS: string,
  shellPlatform: string | null | undefined,
  chromeHoldsLights: boolean,
  leadPx: number,
): number {
  if (!shouldShowShellTitleBand(platformOS, shellPlatform)) return 0;
  return chromeHoldsLights ? leadPx : 0;
}
