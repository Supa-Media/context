import { useEffect } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { useColors } from "../../features/design/theme";
import { landAfterSignIn } from "../../features/auth/landing";
import { resolveAuthRoute } from "../../features/auth/redirect";

/**
 * The sign-in group. A session that already exists has no business here, so it
 * is bounced — to `?next=` when the caller supplied a safe one, and to the
 * console otherwise.
 *
 * The consent screen is what makes `next` earn its keep: someone sent here from
 * `/authorize?request_id=…` has to land back on that exact request, or the AI
 * client's OAuth attempt dies with nothing to retry. The rules — including what
 * makes a `next` target safe to follow — live in `features/auth/redirect.ts`
 * and are tested there.
 */
export default function AuthLayout() {
  const colors = useColors();
  const params = useLocalSearchParams<{ next?: string | string[] }>();
  const next = Array.isArray(params.next) ? params.next[0] : params.next;
  const decision = resolveAuthRoute(useConvexAuth(), next);

  if (decision.action === "wait") return null;
  if (decision.action === "redirect") return <Land href={decision.href} />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.ground },
      }}
    />
  );
}

/**
 * Leave for `href` the way the sign-in screen does.
 *
 * This gate and `LoginScreen.verifyCode` both fire when a session appears, and
 * whichever wins decides whether the link survives — so they must navigate the
 * same way. On the web that is a real navigation: `<Redirect>` is a
 * client-side replace, and a client-side replace through a half-built tree is
 * what drops the `note` a team link is made of. See `landAfterSignIn`.
 */
function Land({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    landAfterSignIn(href, (target) => router.replace(target));
  }, [href, router]);
  return null;
}
