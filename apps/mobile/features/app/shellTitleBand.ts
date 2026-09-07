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
