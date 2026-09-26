/**
 * Publish, on the website folder and in its share dialog.
 *
 * Edits under `website/` wait for this (decided by the owner, 2026-09-26):
 * saving a note changes the note, and pressing Publish makes what the folder
 * holds now the site everybody sees. A site that is off shows its owner the
 * same button, and pressing it turns the site on, which publishes too.
 *
 * The button says what is happening and nothing else: Publish, Publishing…,
 * Published. The one line it may add is the page that stopped a publish,
 * because without it the press would look like it did nothing.
 */

import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useWebsite } from "./useWebsite";

/** The folder a Publish button belongs on. */
export function isWebsiteFolder(path: string): boolean {
  return path === DEFAULT_WEBSITE_ROOT;
}

type Phase = "idle" | "publishing" | "published" | "failed";

/** How long "Published" stays before the button is ready again. */
const DONE_FOR_MS = 2500;

export function publishLabel(phase: Phase): string {
  if (phase === "publishing") return "Publishing…";
  if (phase === "published") return "Published";
  return "Publish";
}

/** What stopped a publish, as one line: the file and why. */
export function publishProblem(problems: ReadonlyArray<{ path: string; message: string }>): string | null {
  const first = problems[0];
  if (first === undefined) return null;
  const name = first.path.slice(first.path.lastIndexOf("/") + 1);
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
  return `${name}: ${first.message}${more}`;
}

export function PublishWebsite({ workspaceId, testID = "website-publish" }: { workspaceId: string; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const { state, actions } = useWebsite(workspaceId);
  const publish = useAction(api.functions.websites.publish);
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const on = state?.state === "enabled";
  const allowed = on ? state.canPublish === true : actions !== undefined;
  if (state === undefined || !allowed) return null;

  const press = () => {
    if (phase === "publishing") return;
    setPhase("publishing");
    setProblem(null);
    const run = on
      ? publish({ workspaceId: workspaceId as Id<"workspaces"> }).then((result) => {
          if (result.published) return null;
          return publishProblem(result.problems) ?? "Someone is still editing. Press Publish again.";
        })
      : actions!.enable().then(() => null);
    void run.then(
      (failure) => {
        if (failure !== null) {
          setProblem(failure);
          setPhase("failed");
          return;
        }
        setPhase("published");
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setPhase("idle"), DONE_FOR_MS);
      },
      () => {
        setProblem("Publishing failed. Try again.");
        setPhase("failed");
      },
    );
  };

  return (
    <View style={styles.box}>
      <Button
        label={publishLabel(phase)}
        variant="mini"
        onPress={press}
        disabled={phase === "publishing"}
        testID={testID}
      />
      {problem === null ? null : (
        <Text variant="treeMeta" style={styles.problem} role="alert" numberOfLines={2} testID={`${testID}-problem`}>
          {problem}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { alignItems: "flex-end", gap: 4, flexShrink: 1 },
    problem: { color: colors.critText, maxWidth: 280, textAlign: "right" },
  });
