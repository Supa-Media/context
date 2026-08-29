/**
 * The origin a share link is built from — native.
 *
 * There is no `window.location` here. The console is a web surface (see
 * `LiveEditor.tsx` for the same split), and a native build has no address bar
 * to read an origin out of, so this returns the product's own origin as the
 * only honest answer available.
 *
 * Kept in step with `EXPO_PUBLIC_SITE_ORIGIN` where one is configured, so a
 * self-hosted native build is not forced to hand out our domain.
 */
export function consoleOrigin(): string {
  const configured = process.env.EXPO_PUBLIC_SITE_ORIGIN;
  return configured !== undefined && configured !== ""
    ? configured
    : "https://context.lc";
}
