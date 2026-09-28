import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex } from "convex/react";

import { api } from "@context/convex/_generated/api";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { FaceView } from "../../faces/PersonFace";
import { useMyFace } from "../../faces/useFace";
import { pickSquarePhoto } from "./pickSquarePhoto";

/**
 * "Your picture": the face other people see beside your name.
 *
 * It is your personal workspace's icon unless you upload a photo, which then
 * wins and is saved with your account rather than in any bucket, so it shows
 * wherever your notes are stored (Dev2, 2026-09-28). With neither, you are the
 * drawn figure in your handle's colours. Shown on the personal workspace's
 * overview, beside the icon it defaults to.
 */
export function YourPicture() {
  const styles = useThemedStyles(makeStyles);
  const mine = useMyFace();
  /*
    `useConvex` rather than `useAction`, because this panel is also mounted
    where no backend is (the landing page's console, the demo), and
    `useAction` throws there. With no client there is nothing to upload to,
    so the section is absent.
  */
  const convex = useConvex() as ReturnType<typeof useConvex> | undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (convex === undefined) return null;

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      const message = (failure as { data?: { message?: string } })?.data?.message;
      setError(message ?? "That didn’t save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    const picked = await pickSquarePhoto();
    if (picked.kind === "canceled") return;
    if (picked.kind === "error") {
      setError(picked.message);
      return;
    }
    await run(() =>
      convex!.action(api.functions.faces.setMyPhoto, { bytes: picked.bytes, contentType: picked.contentType }),
    );
  }

  const [title, detail] = mine.uploaded
    ? ["People see your photo", "Saved with your account, so it always shows, wherever your notes are stored."]
    : mine.face === undefined
      ? ["People see a drawn picture", "Choose an icon for this workspace above, or upload a photo."]
      : ["People see your workspace icon", "Change it above, or upload a photo instead."];

  return (
    <View testID="your-picture">
      <Text variant="listGroup" style={styles.heading}>
        Your picture
      </Text>
      <View style={styles.card}>
        <FaceView face={mine.face} name={mine.handle} size={48} testID="your-picture-face" />
        <View style={styles.words}>
          <Text variant="rowTitle">{title}</Text>
          <Text variant="rowSub">{detail}</Text>
        </View>
        <View style={styles.actions}>
          <Button
            label={mine.uploaded ? "Change photo" : "Upload a photo"}
            onPress={() => void upload()}
            disabled={busy}
            testID="your-picture-upload"
          />
          {mine.uploaded ? (
            <Button
              label="Remove photo"
              onPress={() => void run(() => convex.mutation(api.functions.faces.clearMyPhoto, {}))}
              disabled={busy}
              testID="your-picture-clear"
            />
          ) : null}
        </View>
      </View>
      {error === null ? null : (
        <Text variant="rowSub" style={styles.error} testID="your-picture-error">
          {error}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    heading: { marginTop: space.x6, marginBottom: space.x2 },
    card: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.x3,
      padding: space.x3,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      maxWidth: 560,
    },
    words: { flex: 1, minWidth: 180, gap: 2 },
    actions: { flexDirection: "row", gap: space.x2 },
    error: { marginTop: space.x2, color: colors.critText },
  });
