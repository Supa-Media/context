import { Stack } from "expo-router";
import { useColors } from "../../features/design/theme";

/**
 * The note-link navigator, and **deliberately not a gate**.
 *
 * `/note/@slug/<path>` is the link format anything outside the app produces —
 * see `features/console/noteLink.ts`. It resolves to the canonical console URL
 * and redirects there, and the console's own `(app)` gate is what asks for a
 * session.
 *
 * A session check here would be strictly worse than that, in the way `/s` and
 * `/invite` already document for their own tokens: signing somebody out to
 * `/login?next=/note/@supa/…` sends them back through this route afterwards, so
 * the parameter that has to survive sign-in would be the *link* rather than the
 * address it names. Redirecting first means one hop and one `next`, and the
 * `next` is the URL the console can actually restore.
 */
export default function NoteLinkLayout() {
  const colors = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.ground },
      }}
    />
  );
}
