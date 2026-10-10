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
import { VaultAddForm, type VaultDraft, type VaultInitialDraft } from "./VaultAddForm";
import { VaultViewPage } from "./VaultViewPage";
import {
  PREFILL_KEYS,
  atHandle,
  resolveVaultLinkView,
  type Described,
  type EntryType,
  type Outcome,
  type RawPrefill,
  type VaultLinkView,
  type VaultWorkspace,
} from "./vaultLink";

/**
 * `/vault/<token>`: the page Tex texts when it needs a login or a secret
 * saved, shared or seen.
 *
 * Owns its own sign-in gate, like `/texts/<token>`, so a signed-out visitor
 * goes to `/login?next=/vault/<token>?name=…` and comes straight back with the
 * agent's prefills intact. The request is described once per visit; nothing
 * is saved, shared or revealed until the person presses the button. Revealed
 * values live in this screen's state while it is open, and nowhere else.
 */
export function VaultLinkScreen() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<Record<"token" | (typeof PREFILL_KEYS)[number], string | string[]>>();
  const token = firstParam(params.token);
  const prefill: RawPrefill = {};
  for (const key of PREFILL_KEYS) prefill[key] = firstParam(params[key]);
  const auth = useConvexAuth();
  const describe = useAction(api.functions.vault.describeVaultRequest);
  const save = useAction(api.functions.vault.saveVaultLogin);
  const share = useAction(api.functions.vault.confirmVaultShare);
  const reveal = useAction(api.functions.vault.revealVaultEntry);
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
        setOutcome({ kind: "saved", ...saved, type: draft.type });
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

  // One call per press; the answer stays in this state and is never logged.
  const onReveal = useCallback(() => {
    if (token === null) return;
    setOutcome({ kind: "busy" });
    reveal({ token }).then(
      (entry) => setOutcome({ kind: "revealed", entry }),
      (error: unknown) => setOutcome({ kind: "failed", error }),
    );
  }, [reveal, token]);

  const view = resolveVaultLinkView({ token, auth, prefill, described, outcome });
  if (view.kind === "wait") return <View style={styles.ground} />;
  if (view.kind === "signIn") return <Redirect href={view.href} />;

  return (
    <InvitePage testID="vault-link-page">
      <VaultLinkBody
        view={view}
        onSave={onSave}
        onShare={onShare}
        onReveal={onReveal}
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
  onReveal,
  onDecline,
  initialDraft,
}: {
  view: VaultLinkView;
  onSave: (draft: VaultDraft) => Promise<boolean>;
  onShare: () => void;
  onReveal: () => void;
  onDecline: () => void;
  /** Previews only: a form already typed into. */
  initialDraft?: Partial<VaultInitialDraft>;
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
      return <AddPage view={view} titleSize={titleSize} onSave={onSave} initialDraft={initialDraft} />;
    case "saved":
      return (
        <Ending testID="vault-link-saved" titleSize={titleSize} title="Saved">
          {savedLine(view)}
        </Ending>
      );
    case "view":
      return <VaultViewPage view={view} titleSize={titleSize} onReveal={onReveal} />;
    case "share": {
      const who = atHandle(view.grantee);
      const sites = view.entry.sites.join(", ");
      return (
        <View testID="vault-link-share">
          <Title size={titleSize}>{`Share ${view.entry.name} with ${who}?`}</Title>
          <Text variant="heroSub" style={styles.sub}>
            {view.entry.type === "secret"
              ? `After this, ${who} can see and copy its values, and Tex can paste them for ${who}${sites ? ` on ${sites}` : ""}. The values are never shown to their AI.`
              : `After this, Tex can sign ${who} and their assistants in${sites ? ` to ${sites}` : ""}. The password is filled in for them and never shown to their AI.`}
          </Text>
          <Card style={styles.facts}>
            <FieldList
              testIDPrefix="vault-share"
              fields={[
                ...(sites ? [{ label: view.entry.type === "secret" ? "Fills on" : view.entry.sites.length > 1 ? "Sites" : "Site", value: sites }] : []),
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
          {view.type === "secret"
            ? `${view.name} is theirs to use now. Go back to Messages.`
            : `Tex can now sign them in with ${view.name}. Go back to Messages.`}
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

/** The add form under a heading that follows the Login / Secret switch. */
function AddPage({
  view,
  titleSize,
  onSave,
  initialDraft,
}: {
  view: Extract<VaultLinkView, { kind: "add" }>;
  titleSize: number;
  onSave: (draft: VaultDraft) => Promise<boolean>;
  initialDraft?: Partial<VaultInitialDraft>;
}) {
  const styles = useThemedStyles(makeStyles);
  const [type, setType] = useState<EntryType>(initialDraft?.type ?? view.prefill.type);
  const name = view.prefill.name;
  const title = type === "login" ? (name ? `Save your ${name} login` : "Save a login") : name ? `Save your ${name} keys` : "Save a secret";
  return (
    <View testID="vault-link-add">
      <Title size={titleSize}>{title}</Title>
      <Text variant="heroSub" style={styles.sub}>
        {addLine(type, view.workspace)}
      </Text>
      <VaultAddForm
        prefill={view.prefill}
        initialDraft={initialDraft}
        busy={view.busy}
        problem={view.problem}
        onSave={onSave}
        onType={setType}
      />
    </View>
  );
}

function addLine(type: EntryType, workspace: VaultWorkspace): string {
  const vault = workspace.kind === "personal" ? "your personal vault" : `the ${workspace.name} vault`;
  const yours = workspace.kind === "personal" ? "" : " Only you can use it until you share it.";
  return type === "login"
    ? `So Tex can sign in for you. It goes in ${vault}.${yours}`
    : `API keys and environment variables, sealed in ${vault}. Tex sees their names, never their values.${yours}`;
}

function savedLine(view: Extract<VaultLinkView, { kind: "saved" }>): string {
  if (view.type === "login") return `Tex can sign in to ${view.site} for you now. Go back to Messages.`;
  if (view.site) return `Tex can paste ${view.name} into ${view.site} for you now, without seeing it. Go back to Messages.`;
  return `${view.name} is in your vault. When you need a value, ask Tex for a link to see it. Go back to Messages.`;
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
