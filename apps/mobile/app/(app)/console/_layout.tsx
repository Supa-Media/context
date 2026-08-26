import { useEffect } from "react";
import { Slot, useRouter, usePathname } from "expo-router";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "../../../features/design/components/Button";
import { Text } from "../../../features/design/components/Text";
import { colors, layout } from "../../../features/design/tokens";
import { StageBackdrop } from "../../../features/design/components/StageBackdrop";
import { ConsoleShell } from "../../../features/console/ConsoleShell";
import { ConsoleDataProvider } from "../../../features/console/ConsoleDataContext";
import {
  hrefFor,
  resolveContextRoute,
  routeForPath,
  sameRoute,
} from "../../../features/console/nav";
import { useLiveConsoleData } from "../../../features/console/useLiveConsoleData";

/**
 * The console chrome for every route.
 *
 * The layout owns the Convex subscriptions and hands them down through
 * `ConsoleDataProvider`, so moving between the map, a context, and that
 * context's settings moves a URL without re-fetching everything.
 *
 * It also owns the one piece of coupling the hierarchy creates: **the URL is
 * the truth about which context you are in**, and the selection follows it.
 * The alternative — a selection that the URL merely reflects — means a
 * pasted link lands you in whichever context happened to be selected, which
 * is the bug this restructuring exists to remove.
 */
export default function ConsoleLayout() {
  const data = useLiveConsoleData();
  const router = useRouter();
  const pathname = usePathname();
  const route = routeForPath(pathname);

  const resolution = resolveContextRoute({
    route,
    contexts: data.contexts,
    selectedContextId: data.selectedContextId,
    loading: data.loading,
  });

  const { selectContext } = data;
  useEffect(() => {
    if (resolution.action === "select") selectContext(resolution.contextId);
    if (resolution.action === "redirect") router.replace(resolution.href);
    // `resolution` is derived and stable enough to compare by its parts; the
    // action and its payload are the only things that should retrigger this.
  }, [
    resolution.action,
    resolution.action === "select" ? resolution.contextId : null,
    resolution.action === "redirect" ? resolution.href : null,
    router,
    selectContext,
  ]);

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
              route={route}
              // Pressing the rail entry you are already on should do nothing,
              // not re-enter the route — which on a context would reset the
              // file browser out from under an open note.
              onNavigate={(next) => {
                if (!sameRoute(next, route)) router.replace(hrefFor(next));
              }}
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
