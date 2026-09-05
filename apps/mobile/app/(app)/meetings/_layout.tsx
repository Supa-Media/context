import { Stack } from "expo-router";
import { View, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "../../../features/design/theme";
import { RecordingBar } from "../../../features/meetings/components/RecordingBar";
import { useMeetingsSetup } from "../../../features/meetings/useMeetings";

/**
 * The meetings navigator, and the one place this feature is switched on.
 *
 * **Deliberately not a gate.** The session check is already above it —
 * everything under `(app)` goes through that group's layout, which sends a
 * signed-out visitor to `/login` carrying the attempted href — and a second
 * check here would be a second copy of a rule with one correct implementation.
 * `workspace/_layout.tsx` says the same thing about itself.
 *
 * It does three things:
 *
 *  1. A `Stack` painting the app's own ground, so nothing flashes white on the
 *     way in.
 *  2. `useMeetingsSetup`, which points the controller at the signed-in person's
 *     default context and reads whatever is already on the device. It is here
 *     rather than on each screen so that the list, a live meeting and a
 *     finished note share one configuration.
 *  3. The persistent recording bar, mounted **after** the stack so it paints
 *     over it. That ordering is the mechanism, not the `zIndex`: every
 *     react-native-web `View` opens a stacking context, so a `zIndex` set
 *     inside the stack means nothing out here, and "later sibling wins" is what
 *     actually decides it. See `docs/decisions/app-and-console.md`.
 *
 * **The bar is only app-wide once `app/(app)/_layout.tsx` mounts it too** — one
 * line, `<RecordingBar />` beside that layout's `Stack`. Nothing else has to
 * change, because the recording lives in an external store rather than in a
 * provider (`features/meetings/controller.ts`). That file is the app shell's
 * rather than this feature's, so the line is left for whoever owns it, and
 * until then a recording is visible across every meetings screen and reachable
 * from anywhere through `/meetings`.
 */
export default function MeetingsLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  useMeetingsSetup();

  return (
    <View style={[styles.fill, { backgroundColor: colors.ground }]}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.ground },
        }}
      />
      <RecordingBar bottomInset={insets.bottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
