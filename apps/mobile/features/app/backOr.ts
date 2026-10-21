/**
 * Back to wherever somebody came from, and to `fallback` when that is nowhere.
 *
 * `router.back()` alone is a press that does nothing on a cold start — a typed
 * URL, a deep link, a reload on the web, or a desktop window opened straight
 * onto a screen has no entry behind it — and a control that sometimes does
 * nothing is a screen with no way out. `replace` on that path: there is nothing
 * behind the screen to keep, and pushing would build a history where Back walks
 * between two screens forever.
 */
export function backOr(
  router: { canGoBack: () => boolean; back: () => void; replace: (href: string) => void },
  fallback: string,
): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
