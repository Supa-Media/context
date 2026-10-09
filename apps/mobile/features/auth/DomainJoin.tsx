import { useEffect, useRef } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { useColors } from "../design/theme";
import type { JoinableWorkspace } from "./domainJoin";

/**
 * Joins the workspace a link names, through the person's email domain, then
 * gets out of the way: once the membership lands the app layout draws the
 * link's page itself. Drawn by `app/(app)/_layout.tsx` in place of the route
 * for the moment the join takes. A refusal (switched off since the list was
 * read) lands where any unknown workspace link lands.
 */
export function DomainJoin({
  workspace,
  onJoined,
  onRefused,
}: {
  workspace: JoinableWorkspace;
  onJoined: (workspace: JoinableWorkspace) => void;
  onRefused: () => void;
}) {
  const colors = useColors();
  const join = useMutation(api.functions.workspaceDomains.joinWithDomain);
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (asked.current === workspace.slug) return;
    asked.current = workspace.slug;
    join({ slug: workspace.slug }).then(
      () => onJoined(workspace),
      () => onRefused(),
    );
  }, [join, workspace, onJoined, onRefused]);

  return (
    <View style={[styles.fill, { backgroundColor: colors.ground }]} testID="domain-join">
      <ActivityIndicator color={colors.ink} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
});
