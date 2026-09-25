/**
 * The Credentials tab.
 *
 * A secret is written here and never read back. There is no "reveal" control
 * and no place to put one: `listSecrets` returns a fingerprint and the control
 * plane has no function that returns a value at all. What this offers is set,
 * replace and delete, and the fingerprint is how somebody confirms the paste
 * landed — see `functions/lib/appSecrets.ts` for why it is a hash rather than
 * the last four characters.
 *
 * Not set comes first, because those are the rows somebody can act on, and
 * each says what is broken while it is missing rather than a neutral "unset".
 */

import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  Dot,
  Notice,
  Text,
  fonts,
  leading,
  radii,
  space,
  useThemedStyles,
  type Colors,
} from "../design";
import { pointerType } from "../design/tokens";
import { EmptyNote, NoticeLine, Panel, Skeleton, useCompact, usePanelPad } from "./AdminKit";
import { DeleteSecretDialog, SetSecretDialog } from "./SecretDialogs";
import { KNOWN_SECRETS, relativeTime, type KnownSecret } from "./report";

/** A configured row, as `listSecrets` returns it. Never a value. */
export interface SecretRow {
  name: string;
  description?: string;
  fingerprint: string;
  updatedAt: number;
  updatedByEmail?: string;
}

type Dialog =
  | { kind: "set"; name: string }
  | { kind: "replace"; name: string }
  | { kind: "delete"; name: string };

export function SecretsSection({
  secrets,
  unset,
}: {
  /** `undefined` while loading. Subscribed once, by `Console`, for the tab count. */
  secrets: readonly SecretRow[] | undefined;
  unset: readonly KnownSecret[];
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [saved, setSaved] = useState<{ name: string; fingerprint: string } | null>(null);

  const close = () => setDialog(null);

  return (
    <View style={styles.section}>
      <View style={[styles.head, compact && styles.headCompact]}>
        <Text variant="meta" style={[styles.headNote, compact && styles.textCompact]}>
          Encrypted at rest and never shown again. The fingerprint is a hash of the value, not part
          of it.
        </Text>
        <Button
          label="Add credential"
          variant="dialogPrimary"
          onPress={() => {
            setSaved(null);
            setDialog({ kind: "set", name: "" });
          }}
          style={compact ? styles.addCompact : styles.add}
          testID="admin-secret-add"
        />
      </View>

      {saved ? (
        <Notice tone="ok" testID="admin-secret-saved">
          <NoticeLine mark="✓" tone="ok">
            <Text style={styles.savedName}>{saved.name}</Text> set — fingerprint{" "}
            <Text style={styles.fingerprint}>{saved.fingerprint}</Text>
          </NoticeLine>
        </Notice>
      ) : null}

      {secrets === undefined ? (
        <Card>
          <Skeleton width={120} height={14} />
          <Skeleton width="100%" height={120} style={styles.skGap} />
        </Card>
      ) : (
        <>
          {unset.length > 0 ? (
            <Panel flush title="Not set" meta={`${unset.length} the code expects`}>
              {unset.map((known, index) => (
                <CredentialRow
                  key={known.name}
                  name={known.name}
                  first={index === 0}
                  actions={
                    <Button
                      label="Set"
                      onPress={() => {
                        setSaved(null);
                        setDialog({ kind: "set", name: known.name });
                      }}
                      testID={`admin-secret-pick-${known.name}`}
                    />
                  }
                >
                  <Text variant="meta" style={compact ? styles.textCompact : null}>
                    {known.description}
                  </Text>
                  {/* What is actually broken while this is missing, rather than
                      a neutral "unset" — the difference between a checklist
                      and a page somebody can act on. */}
                  <View style={styles.breaks}>
                    <Dot tone="warn" style={styles.breaksDot} />
                    <Text variant="meta" style={[styles.warn, compact && styles.textCompact]}>
                      {known.unsetMeans}
                    </Text>
                  </View>
                </CredentialRow>
              ))}
            </Panel>
          ) : null}

          <Panel flush title="Configured" meta={String(secrets.length)}>
            {secrets.length === 0 ? (
              <EmptyNote
                title="Nothing is configured yet"
                body="Add a credential, or set one of the names above."
              />
            ) : (
              secrets.map((row, index) => (
                <CredentialRow
                  key={row.name}
                  name={row.name}
                  first={index === 0}
                  fresh={saved?.name === row.name}
                  testID={`admin-secret-row-${row.name}`}
                  actions={
                    <>
                      <Text variant="meta" style={styles.fpLabel}>
                        fingerprint
                      </Text>
                      <Text style={styles.fingerprint}>{row.fingerprint}</Text>
                      <View style={compact ? styles.spacer : styles.fpGap} />
                      <Button
                        label="Replace"
                        onPress={() => {
                          setSaved(null);
                          setDialog({ kind: "replace", name: row.name });
                        }}
                        testID={`admin-secret-replace-${row.name}`}
                      />
                      <Button
                        label="Delete"
                        variant="danger"
                        onPress={() => {
                          setSaved(null);
                          setDialog({ kind: "delete", name: row.name });
                        }}
                        testID={`admin-secret-delete-${row.name}`}
                      />
                    </>
                  }
                >
                  {row.description ? (
                    <Text variant="meta" style={compact ? styles.textCompact : null}>
                      {row.description}
                    </Text>
                  ) : null}
                  <Text variant="meta" style={compact ? styles.textCompact : null}>
                    set {relativeTime(row.updatedAt)}
                    {row.updatedByEmail ? ` by ${row.updatedByEmail}` : ""}
                  </Text>
                </CredentialRow>
              ))
            )}
          </Panel>
        </>
      )}

      <Text variant="foot" style={compact ? styles.textCompact : null}>
        {KNOWN_SECRETS.length} names are known to the code; any other name is accepted too. Keys
        the deployment needs before it can read this table stay in the environment and are refused
        here.
      </Text>

      {dialog?.kind === "set" || dialog?.kind === "replace" ? (
        <SetSecretDialog
          replacing={dialog.kind === "replace"}
          initialName={dialog.name}
          unset={unset}
          onClose={close}
          onSaved={(result) => {
            setDialog(null);
            setSaved({ name: result.name, fingerprint: result.fingerprint });
          }}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteSecretDialog name={dialog.name} onClose={close} onDeleted={close} />
      ) : null}
    </View>
  );
}

/**
 * One credential: the name in the key colour, lines under it, and the
 * actions beside them on a pointer or under them on a phone.
 */
function CredentialRow({
  name,
  first,
  fresh = false,
  actions,
  children,
  testID,
}: {
  name: string;
  first: boolean;
  fresh?: boolean;
  actions: ReactNode;
  /** The lines under the name. */
  children: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const pad = usePanelPad();
  return (
    <View
      style={[
        styles.row,
        { paddingHorizontal: pad.x },
        !first && styles.ruled,
        fresh && styles.fresh,
        compact && styles.rowCompact,
      ]}
      testID={testID}
    >
      <View style={styles.rowMain}>
        <Text style={[styles.name, compact && styles.nameCompact]}>{name}</Text>
        {children}
      </View>
      <View style={[styles.actions, compact && styles.actionsCompact]}>{actions}</View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    headCompact: { flexDirection: "column", alignItems: "stretch" },
    headNote: { flexShrink: 1 },
    add: { paddingVertical: 6, paddingHorizontal: 13 },
    addCompact: { alignSelf: "stretch", paddingVertical: 11 },
    textCompact: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },

    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x4,
      paddingVertical: 14,
    },
    rowCompact: { flexDirection: "column", alignItems: "stretch", gap: space.x2 },
    ruled: { borderTopWidth: 1, borderTopColor: colors.line },
    fresh: { backgroundColor: colors.okWash },
    rowMain: { flex: 1, minWidth: 0, gap: space.x1 },
    name: {
      fontFamily: fonts.mono,
      fontSize: pointerType.ui,
      lineHeight: leading(pointerType.ui, 1.55),
      fontWeight: "500",
      color: colors.codeKey,
    },
    nameCompact: { fontSize: pointerType.ui },
    breaks: { flexDirection: "row", alignItems: "center", gap: 6 },
    breaksDot: { alignSelf: "center" },
    warn: { color: colors.warnText },

    actions: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    actionsCompact: { marginTop: space.x1 },
    fpLabel: { fontSize: pointerType.label, marginRight: 2 },
    fingerprint: {
      fontFamily: fonts.mono,
      fontSize: pointerType.meta,
      color: colors.text2,
      backgroundColor: colors.well,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.xs,
      paddingHorizontal: space.x2,
      paddingVertical: 2,
      overflow: "hidden",
    },
    fpGap: { width: space.x2 },
    spacer: { flex: 1 },
    savedName: {
      fontFamily: fonts.mono,
      fontSize: pointerType.ui,
      fontWeight: "500",
      color: colors.text,
    },

    skGap: { marginTop: 18 },
  });
