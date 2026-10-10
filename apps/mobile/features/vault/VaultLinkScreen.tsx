import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { FieldList } from "../design/components/Field";
import { FormError } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { clamp, leading, pointerType as t } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { InvitePage, Title } from "../invite/InviteScreen";
import { firstParam } from "../invite/invite";
import { VaultAddForm, type VaultDraft } from "./VaultAddForm";
import {
  atHandle,
  resolveVaultLinkView,
  type Described,
  type Outcome,
  type VaultLinkView,
} from "./vaultLink";

/**
 * `/vault/<token>`: the page Tex texts when it needs a login saved or shared.
 *
 * Owns its own sign-in gate, like `/texts/<token>`, so a signed-out visitor
 * goes to `/login?next=/vault/<token>?name=…` and comes straight back with the
 * agent's prefills intact. The request is described once per visit; nothing
 * is saved or shared until the person presses the button.
 */
export function VaultLinkScreen() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{
    token?: string | string[];
    name?: string | string[];
    site?: string | string[];
  }>();
  const token = firstParam(params.token);
  const prefill = { name: firstParam(params.name) ?? "", site: firstParam(params.site) ?? "" };
  const auth = useConvexAuth();
  const describe = useAction(api.functions.vault.describeVaultRequest);
  const save = useAction(api.functions.vault.saveVaultLogin);
  const share = useAction(api.functions.vault.confirmVaultShare);
  const [described, setDescribed] = useState<Described>({ kind: "idle" });
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current || !auth.isAuthenticated || token === null) return;
    asked.current = true;
    setDescribed({ kind: "loading" });
    describe({ token }).then(
      (request) => setDescribed({ kind: "shown", request }),
      (error: unknown) => setDescribed({ kind: "failed", error }),
    );
  }, [auth.isAuthenticated, describe, token]);

  // Resolves true on success so the form can drop the password it held.
  const onSave = useCallback(
    async (draft: VaultDraft): Promise<boolean> => {
      if (token === null) return false;
      setOutcome({ kind: "busy" });
      try {
        const saved = await save({ token, ...draft });
        setOutcome({ kind: "saved", ...saved });
        return true;
      } catch (error: unknown) {
        setOutcome({ kind: "failed", error });
        return false;
      }
    },
    [save, token],
  );

  const onShare = useCallback(() => {
    if (token === null) return;
    setOutcome({ kind: "busy" });
    share({ token }).then(
      (shared) => setOutcome({ kind: "shared", ...shared }),
      (error: unknown) => setOutcome({ kind: "failed", error }),
    );
  }, [share, token]);

  const view = resolveVaultLinkView({ token, auth, prefill, described, outcome });
  if (view.kind === "wait") return <View style={styles.ground} />;
  if (view.kind === "signIn") return <Redirect href={view.href} />;

  return (
    <InvitePage testID="vault-link-page">
      <VaultLinkBody
        view={view}
        onSave={onSave}
        onShare={onShare}
        onDecline={() => setOutcome({ kind: "declined" })}
      />
    </InvitePage>
  );
}

/** Every state but the redirects, drawable without a session. */
export function VaultLinkBody({
  view,
  onSave,
  onShare,
  onDecline,
  initialDraft,
}: {
  view: VaultLinkView;
  onSave: (draft: VaultDraft) => Promise<boolean>;
  onShare: () => void;
  onDecline: () => void;
  /** Previews only: a form already typed into. */
  initialDraft?: Partial<VaultDraft>;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 36, width);

  switch (view.kind) {
    case "wait":
    case "signIn":
      return null;
    case "loading":
      return (
        <Card>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="rowSub">Opening your link…</Text>
          </View>
        </Card>
      );
    case "dead":
      return (
        <Ending testID={`vault-link-${view.reason === "notYours" ? "not-yours" : "dead"}`} titleSize={titleSize} title={view.headline}>
          {view.detail}
        </Ending>
      );
    case "add":
      return (
        <View testID="vault-link-add">
          <Title size={titleSize}>{view.prefill.name ? `Save your ${view.prefill.name} login` : "Save a login"}</Title>
          <Text variant="heroSub" style={styles.sub}>
            {view.workspace.kind === "personal"
              ? "So Tex can sign in for you. It goes in your personal vault."
              : `So Tex can sign in for you. It goes in the ${view.workspace.name} vault, and only you can use it until you share it.`}
          </Text>
          <VaultAddForm
            prefill={view.prefill}
            initialDraft={initialDraft}
            busy={view.busy}
            problem={view.problem}
            onSave={onSave}
          />
        </View>
      );
    case "saved":
      return (
        <Ending testID="vault-link-saved" titleSize={titleSize} title="Saved">
          {`Tex can sign in to ${view.site} for you now. Go back to Messages.`}
        </Ending>
      );
    case "share": {
      const who = atHandle(view.grantee);
      const sites = view.entry.sites.join(", ");
      return (
        <View testID="vault-link-share">
          <Title size={titleSize}>{`Share ${view.entry.name} with ${who}?`}</Title>
          <Text variant="heroSub" style={styles.sub}>
            {`After this, Tex can sign ${who} and their assistants in${sites ? ` to ${sites}` : ""}. The password is filled in for them and never shown to their AI.`}
          </Text>
          <Card style={styles.facts}>
            <FieldList
              testIDPrefix="vault-share"
              fields={[
                ...(sites ? [{ label: view.entry.sites.length > 1 ? "Sites" : "Site", value: sites }] : []),
                { label: "Workspace", value: view.workspace.name },
              ]}
            />
          </Card>
          {view.problem ? (
            <FormError headline={view.problem.headline} next={view.problem.next} style={styles.error} />
          ) : null}
          <View style={styles.decisions}>
            <Button
              label={view.busy ? "Sharing…" : "Share"}
              variant="accent"
              style={styles.decision}
              disabled={view.busy}
              accessibilityLabel={`Share ${view.entry.name} with ${who}`}
              onPress={onShare}
              trailing={view.busy ? <ActivityIndicator color={colors.ink} size="small" /> : null}
              testID="vault-share-confirm"
            />
            <Button
              label="Not now"
              variant="decision"
              style={styles.decision}
              disabled={view.busy}
              onPress={onDecline}
              testID="vault-share-decline"
            />
          </View>
        </View>
      );
    }
    case "shared":
      return (
        <Ending testID="vault-link-shared" titleSize={titleSize} title={`Shared with ${atHandle(view.grantee)}`}>
          {`Tex can now sign them in with ${view.name}. Go back to Messages.`}
        </Ending>
      );
    case "declined":
      return (
        <Ending testID="vault-link-declined" titleSize={titleSize} title="Not shared">
          Nothing changed. You can close this page.
        </Ending>
      );
  }
}

/** A state with nothing left to do here: a heading and one line. */
function Ending({
  titleSize,
  title,
  children,
  testID,
}: {
  titleSize: number;
  title: string;
  children: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID={testID}>
      <Title size={titleSize}>{title}</Title>
      <Text variant="heroSub" style={styles.sub}>
        {children}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    sub: { marginTop: 14, fontSize: t.body, lineHeight: leading(t.body, 1.55) },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
    facts: { marginTop: 24 },
    error: { marginTop: 16 },
    decisions: { marginTop: 24, flexDirection: "row", gap: 12 },
    // Same size for both answers: saying no is a real answer, not the small print.
    decision: { flex: 1, alignSelf: "auto", justifyContent: "center" },
  });
