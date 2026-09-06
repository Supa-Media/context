import { Stack } from "expo-router";
import { View, StyleSheet } from "react-native";
import { useColors } from "../../../features/design/theme";

/**
 * The meetings navigator, and the one place this feature is switched on.
 *
 * **Deliberately not a gate.** The session check is already above it —
 * everything under `(app)` goes through that group's layout, which sends a
 * signed-out visitor to `/login` carrying the attempted href — and a second
 * check here would be a second copy of a rule with one correct implementation.
 * `workspace/_layout.tsx` says the same thing about itself.
 *
 * It does one thing: a `Stack` painting the app's own ground, so nothing
 * flashes white on the way in.
 *
 * **It no longer calls `useMeetingsSetup`.** That used to live here, and the
 * paragraph below already records why the transcription client had to leave
 * for the same reason — this layout unmounts the moment somebody leaves
 * `/meetings/*`, which is the wrong half of the app for anything a recording
 * outlives. The setup is now mounted once in `app/(app)/_layout.tsx`, beside
 * the bar and the transcription client.
 *
 * There is a second reason now, and it is why the last one moved rather than
 * being duplicated: the console's microphone key can start a meeting without
 * `/meetings` ever having been mounted, so the controller has to be pointed at
 * the signed-in person *before* that key is pressed. A setup that only runs
 * once somebody has visited the meetings list is a setup that is missing
 * exactly when the new entry point needs it.
 *
 * **It does not install the transcription client either**, for the reason
 * above; `useTranscriptionClient` is called beside the bar, in
 * `app/(app)/_layout.tsx`.
 *
 * **It does not mount the recording bar.** It used to, which made a recording
 * visible on meetings screens and nowhere else; the bar is now mounted once at
 * `app/(app)/_layout.tsx`, above every route in the section. Mounting it in both
 * places is not belt and braces — it is two bars drawn over each other on every
 * screen in this section, because this layout renders *inside* that one.
 */
export default function MeetingsLayout() {
  const colors = useColors();

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
