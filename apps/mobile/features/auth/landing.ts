/**
 * How the app returns somebody to the URL they were sent, after signing in.
 *
 * ## Why this is not `router.replace(next)`
 *
 * Measured in Chromium against the real router, following
 * `/console/@seyi?note=3-resources%2Fengineering%2Fshipping-an-expo-app-safely.md`
 * signed out. The gate hands `/login` the right `next` — that part is fine and
 * was verified separately — and then the client-side navigation lands in two
 * stages:
 *
 *     t+1500ms   /console/@seyi?slug=%40seyi
 *     t+3000ms   /console/@seyi?slug=%40seyi&note=3-resources%2F…md
 *
 * The first of those is the URL a person actually reported being left on. It
 * is the same defect `attemptedHref.ts` documents, seen from the other side:
 * expo-router re-serializes the URL from React Navigation's state, and while
 * the tree is still being built that state is incomplete — so the `note` the
 * link exists for is dropped and `[slug]`, which belongs in the path, is
 * emitted as a query parameter. Whether the second stage ever arrives depends
 * on how the rest of the tree settles, which is not something a link's
 * correctness may rest on.
 *
 * ## What it does instead, on the web
 *
 * A real navigation. `window.location.replace` sets the URL to `next`
 * byte-for-byte — there is no state to re-serialize and nothing that can drop
 * a parameter — and the app then cold-loads at exactly that address with a
 * session already in storage. That is precisely the signed-in cold start,
 * which is the path `useLinkedNote` was built for and which is verified
 * working; the signed-out case becomes the case that already works rather
 * than a second one to keep correct.
 *
 * `replace` rather than `assign`, so Back does not return to a sign-in screen
 * that would immediately bounce them forward again.
 *
 * The cost is one page load after entering a code, on the one navigation in
 * the product where a person is already waiting for a round trip. Set against
 * a link that silently loses what it points at, that is not a close call.
 *
 * ## And on native
 *
 * There is no `window.location` to assign and no page to reload, so the
 * router's own navigation is the only mechanism there. It is also the narrower
 * case: this fires after an in-app sign-in, where the tree below the gate is
 * already mounted.
 */
export function landAfterSignIn(next: string, fallback: (href: string) => void): void {
  const location = typeof window === "undefined" ? undefined : window.location;
  // The same test `attemptedHrefFrom` makes, and for the same reason: a
  // `window` with no `location` is React Native, not a broken browser.
  if (location && typeof location.replace === "function" && typeof location.pathname === "string") {
    location.replace(next);
    return;
  }
  fallback(next);
}
