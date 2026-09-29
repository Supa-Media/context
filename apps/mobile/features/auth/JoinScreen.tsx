import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { Text } from "../design/components/Text";
import { space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { joinScreenFor } from "./joinInvite";
import { LoginScreen } from "./LoginScreen";

/**
 * `/join/<token>`: a friend's invite, opened from the email. It is `/login`
 * with who invited you on top (`LoginScreen`'s `join`), so the field, the code
 * and first run afterwards are the ones everybody else gets.
 *
 * `referrals.preview` needs no session and says only whether the link works
 * and who sent it. The server lets in exactly the address the invite went to;
 * a forwarded link does nothing for anybody else, and the page says so.
 */
export function JoinScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const live = token !== undefined && token.trim().length > 0 && token.length <= 100;
  const preview = useQuery(api.functions.referrals.preview, live ? { token } : "skip");
  const state = joinScreenFor(live ? token : undefined, preview);

  if (state.kind === "loading") return <JoinLoading />;
  return <LoginScreen join={state} />;
}

function JoinLoading() {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.ground}>
      <CenteredScroll testID="join-loading">
        <View style={styles.row}>
          <ActivityIndicator color={colors.text2} size="small" />
          <Text variant="rowSub">Checking this invite…</Text>
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.x2, paddingVertical: 48 },
  });
