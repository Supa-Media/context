import { Slot, useRouter, usePathname } from "expo-router";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "../../../features/design/components/Button";
import { Text } from "../../../features/design/components/Text";
import { colors, layout } from "../../../features/design/tokens";
import { StageBackdrop } from "../../../features/design/components/StageBackdrop";
import { ConsoleShell } from "../../../features/console/ConsoleShell";
import { ConsoleDataProvider } from "../../../features/console/ConsoleDataContext";
import { paneForPath, paneHref } from "../../../features/console/panes";
import { useLiveConsoleData } from "../../../features/console/useLiveConsoleData";

/**
 * The console chrome for every pane.
 *
 * The layout owns the Convex subscriptions and hands them down through
 * `ConsoleDataProvider`, so switching panes moves a URL without re-fetching or
 * resetting which context you were looking at.
 */
export default function ConsoleLayout() {
  const data = useLiveConsoleData();
  const router = useRouter();
  const pathname = usePathname();
  const pane = paneForPath(pathname);

  return (
    <ConsoleDataProvider value={data}>
      <ScrollView style={styles.ground} contentContainerStyle={styles.scroll}>
        <View style={styles.stage}>
          <StageBackdrop />
          <View style={styles.wrap}>
            <View style={styles.top}>
              <Pressable
                onPress={() => router.push("/")}
                role="link"
                accessibilityLabel="Context.lc home"
              >
                <Text variant="mark">
                  Context
                  <Text variant="mark" style={styles.markSuffix}>
                    .lc
                  </Text>
                </Text>
              </Pressable>
              <SignOutButton />
            </View>

            <ConsoleShell
              data={data}
              activePane={pane}
              onSelectPane={(key) => router.replace(paneHref(key))}
            >
              <Slot />
            </ConsoleShell>

            <View style={styles.foot}>
              <Text variant="foot">Free. You bring the bucket.</Text>
              <Text variant="foot">MIT · self-hostable</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </ConsoleDataProvider>
  );
}

function SignOutButton() {
  const router = useRouter();
  const { signOut } = useAuthActions();
  return (
    <Button
      label="Sign out"
      onPress={() => {
        void signOut().then(() => router.replace("/"));
      }}
    />
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
  scroll: { minHeight: "100%" },
  stage: { position: "relative", overflow: "hidden", flex: 1 },
  wrap: {
    width: "100%",
    maxWidth: layout.maxWidth,
    marginHorizontal: "auto",
    paddingHorizontal: layout.gutter,
  },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 26,
  },
  markSuffix: { color: colors.muted },
  foot: {
    paddingTop: 28,
    paddingBottom: 48,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 20,
  },
});
