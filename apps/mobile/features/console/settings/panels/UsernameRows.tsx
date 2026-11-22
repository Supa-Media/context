import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../../design/components/Button";
import { Row, Grow } from "../../../design/components/Card";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { TextLink } from "../../../design/components/TextLink";
import { space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { nameFeedback, nameStatus, normalizedName, shouldCheckAvailability } from "../../../onboarding/name";
import { settingsHref } from "../../nav";

/**
 * The Username row on Settings › Profile, with Change (Dev2, 2026-11-22: "only allow people to change twice in a
 * lifetime, and let them keep their old name"). The server decides (`functions/names.ts` `changeMyUsername`); this
 * shows what it will do first: the new name, that the old one stays theirs and keeps working, and how many changes
 * are left. A former name of their own is always free to them, so it is offered without asking the server.
 */
export function UsernameRows({ username }: { username: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const state = useQuery(api.functions.names.myUsername, isAuthenticated ? {} : "skip");
  const changeUsername = useMutation(api.functions.names.changeMyUsername);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = state?.username ?? username;
  const former = state?.formerNames ?? [];
  const left = state?.changesLeft ?? 0;
  const wanted = normalizedName(typed);
  const ownFormer = former.includes(wanted);
  const asks = editing && !ownFormer && wanted !== current && shouldCheckAvailability(typed);
  const availability = useQuery(api.functions.names.checkNameAvailable, asks ? { name: wanted } : "skip");
  const status = ownFormer ? ({ kind: "available", normalized: wanted } as const) : nameStatus(typed, availability);
  const feedback = wanted === current && typed !== "" ? { tone: "crit" as const, message: "That is already your username." } : nameFeedback(status);
  const ready = status.kind === "available" && wanted !== current && left > 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const after = await changeUsername({ name: wanted });
      setEditing(false);
      setTyped("");
      // The page's address names the workspace by its handle: move it to the new one.
      router.replace(settingsHref(after.username, "profile"));
    } catch (failure) {
      const message = (failure as { data?: { message?: string } })?.data?.message;
      setError(message ?? "That didn't change. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Row style={styles.firstRow}>
        <Grow>
          <Text variant="rowTitle">Username</Text>
          {former.length > 0 ? (
            <Text variant="rowSub" style={styles.rowSub} testID="username-former">
              Still yours, and still works: {former.map((name) => `@${name}`).join(", ")}
            </Text>
          ) : null}
        </Grow>
        <Text variant="mono" testID="username-current">{current}</Text>
        {state === undefined || state === null || left === 0 || editing ? null : (
          <TextLink label="Change" accessibilityLabel="Change your username" onPress={() => setEditing(true)} testID="username-change" />
        )}
      </Row>
      {editing ? (
        <Row divided>
          <Grow>
            <TextField
              label="New username"
              value={typed}
              onChangeText={setTyped}
              placeholder={current}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              error={feedback?.tone === "crit" ? feedback.message : undefined}
              hint={feedback?.tone === "crit" ? undefined : ownFormer ? `@${wanted} is one of yours.` : feedback?.message}
              testID="username-input"
            />
            <Text variant="rowSub" style={styles.rowSub}>
              {`Your address, links and @${current} keep working, and @${current} stays yours. ` +
                (left === 1 ? "This is your last change." : `You can change it ${left} more times.`)}
            </Text>
            {error !== null ? (
              <Text variant="rowSub" style={[styles.rowSub, { color: colors.crit }]} testID="username-error">
                {error}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button
                label={ready ? `Change to @${wanted}` : "Change"}
                disabled={!ready || busy}
                onPress={() => void save()}
                testID="username-save"
              />
              <TextLink label="Cancel" onPress={() => (setEditing(false), setTyped(""), setError(null))} testID="username-cancel" />
            </View>
          </Grow>
        </Row>
      ) : null}
    </>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    rowSub: { marginTop: 2, maxWidth: 520 },
    firstRow: { paddingBottom: 10 },
    actions: { marginTop: space.x2, flexDirection: "row", alignItems: "center", gap: space.x3 },
  });
