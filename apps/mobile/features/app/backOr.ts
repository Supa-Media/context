import { CONSOLE_ROOT } from "../console/nav";

/**
 * Back to wherever somebody came from, and to the console when that is nowhere.
 *
 * `router.back()` alone is a press that does nothing on a cold start — a typed
 * URL, a deep link, a Live Activity, a reload on the web, or a desktop window
 * opened straight onto a screen has no entry behind it — and a control that
 * sometimes does nothing is a screen with no way out. `CONSOLE_ROOT` because
 * `nav.ts` calls it "the one destination that is always meaningful". `replace`
 * on that path: there is nothing behind the screen to keep, and pushing would
 * build a history where Back walks between two screens forever.
 */
export function backOrConsole(router: {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: string) => void;
}): void {
  if (router.canGoBack()) router.back();
  else router.replace(CONSOLE_ROOT);
}
