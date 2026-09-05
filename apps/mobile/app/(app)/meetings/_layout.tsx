import { Stack } from "expo-router";
import { View, StyleSheet } from "react-native";
import { useColors } from "../../../features/design/theme";
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
 * It does two things:
 *
 *  1. A `Stack` painting the app's own ground, so nothing flashes white on the
 *     way in.
 *  2. `useMeetingsSetup`, which points the controller at the signed-in person's
 *     default context and reads whatever is already on the device. It is here
 *     rather than on each screen so that the list, a live meeting and a
 *     finished note share one configuration.
 *
 * **It does not install the transcription client either.** That used to be
 * inside `useMeetingsSetup`, which put it on the half of the app that does *not*
 * outlive a recording: this layout unmounts the moment somebody leaves
 * `/meetings/*`, and from the next chunk on the recorders had nowhere to send.
 * `useTranscriptionClient` is now called beside the bar, in
 * `app/(app)/_layout.tsx`, for the same reason the bar is there.
 *
 * **It does not mount the recording bar.** It used to, which made a recording
 * visible on meetings screens and nowhere else; the bar is now mounted once at
 * `app/(app)/_layout.tsx`, above every route in the section. Mounting it in both
 * places is not belt and braces — it is two bars drawn over each other on every
 * screen in this section, because this layout renders *inside* that one.
 */
export default function MeetingsLayout() {
  const colors = useColors();
  useMeetingsSetup();

  return (
    <View style={[styles.fill, { backgroundColor: colors.ground }]}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.ground },
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
