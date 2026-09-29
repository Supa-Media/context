import { StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { fonts, leading, pointerType as t, radii, space, tracking } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { EXPIRED_BODY, EXPIRED_TITLE, invitedLine, inviterInitial, type JoinVariant } from "./joinInvite";

/**
 * The top of `/join/<token>`, above `/login`'s own email field: who invited
 * you and the pitch, or that the link no longer works. Everything under it is
 * the sign-in screen unchanged (`LoginScreen`).
 */
export function JoinHeading({ variant }: { variant: JoinVariant }) {
  const styles = useThemedStyles(makeStyles);

  if (variant.kind === "expired") {
    return (
      <View testID="join-expired">
        <View style={styles.mark} aria-hidden>
          <Text style={styles.markText}>!</Text>
        </View>
        <Text role="heading" aria-level={1} style={styles.pitch}>
          {EXPIRED_TITLE}
        </Text>
        <Text variant="rowSub" style={styles.body}>
          {EXPIRED_BODY}
        </Text>
      </View>
    );
  }

  return (
    <View testID="join-invite">
      <View style={styles.inviter}>
        <View style={styles.face} aria-hidden>
          <Text style={styles.faceText}>{inviterInitial(variant.inviterHandle)}</Text>
        </View>
        <Text variant="rowSub" style={styles.inviterText}>
          {invitedLine(variant.inviterHandle)}
        </Text>
      </View>
      <Text role="heading" aria-level={1} style={styles.pitch}>
        Notes for your team and your AI tools
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    inviter: { flexDirection: "row", alignItems: "center", gap: space.x2, marginBottom: space.x3 },
    face: {
      width: 24,
      height: 24,
      borderRadius: radii.pill,
      backgroundColor: colors.surface3,
      alignItems: "center",
      justifyContent: "center",
    },
    faceText: { fontSize: t.meta, fontWeight: "600", color: colors.text2 },
    inviterText: { color: colors.text2 },
    mark: {
      width: 28,
      height: 28,
      borderRadius: radii.pill,
      backgroundColor: colors.surface3,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: space.x3,
    },
    markText: { color: colors.warn, fontWeight: "700" },
    pitch: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    body: { marginTop: space.x3, color: colors.text2, lineHeight: leading(12.5, 1.5) },
  });
