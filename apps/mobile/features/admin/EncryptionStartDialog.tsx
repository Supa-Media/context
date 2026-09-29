/**
 * Starting managed-storage encryption: pick who goes first (Board 3).
 *
 * "Our own workspaces first" is selected on arrival, because our own notes
 * find the problems before a customer's do. The primary button always says
 * how many it will take on.
 */

import { useMemo, useState } from "react";
import { StyleSheet } from "react-native";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, ChoiceGroup, Text, space, useThemedStyles, type Colors } from "../design";
import { ToggleGroup } from "../design/components/Input";
import { useCompact } from "./AdminKit";
import { DialogShell, messageFor } from "./SecretDialogs";
import {
  canStart,
  scopeOptions,
  startCount,
  startLabel,
  type RolloutCandidate,
  type RolloutScope,
} from "./encryption";

export function EncryptionStartDialog({ onClose }: { onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  // `api` is read inside the memo: it mints a new proxy on every access.
  const spec = useMemo<RequestForQueries>(
    () => ({ candidates: { query: api.functions.managedEncryption.rolloutCandidates, args: {} } }),
    [],
  );
  const results = useQueries(spec);
  const raw = results.candidates as RolloutCandidate[] | Error | undefined;
  const candidates = Array.isArray(raw) ? raw : [];
  const loadFailed = raw instanceof Error;

  const startRollout = useMutation(api.functions.managedEncryption.startRollout);
  const [scope, setScope] = useState<RolloutScope>("ours");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = startCount(scope, candidates, picked);
  const ready = Array.isArray(raw) && canStart(scope, count);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await startRollout({
        scope,
        ...(scope === "picked"
          ? { workspaceIds: [...picked] as Id<"workspaces">[] }
          : {}),
      });
      onClose();
    } catch (caught) {
      setError(messageFor(caught, "That didn't start. Try again."));
      setBusy(false);
    }
  }

  const buttonStyle = compact ? styles.actionCompact : undefined;
  const cancel = (
    <Button key="cancel" label="Cancel" variant="dialog" onPress={onClose} style={buttonStyle} />
  );
  const primary = (
    <Button
      key="start"
      label={busy ? "Starting…" : startLabel(scope, count)}
      variant="dialogPrimary"
      disabled={busy || !ready}
      onPress={() => void start()}
      style={buttonStyle}
      testID="admin-encryption-start-confirm"
    />
  );

  return (
    <DialogShell
      title="Start encrypting managed storage"
      sub={<Text variant="paneSub">Files are encrypted in the background. People keep working as usual.</Text>}
      actions={compact ? [primary, cancel] : [cancel, primary]}
      onClose={onClose}
      testID="admin-encryption-start"
    >
      <ChoiceGroup
        label="Who goes first"
        options={scopeOptions(candidates)}
        value={scope}
        onChange={setScope}
        disabled={busy}
        testID="admin-encryption-scope"
      />
      {scope === "picked" ? (
        candidates.length === 0 ? (
          <Text variant="meta">{loadFailed ? "Couldn't load the managed workspaces." : "No managed workspaces yet."}</Text>
        ) : (
          <ToggleGroup
            label="Workspaces"
            options={candidates.map((candidate) => ({
              value: candidate.workspaceId,
              label: `@${candidate.slug}`,
              on: picked.has(candidate.workspaceId),
            }))}
            onToggle={(value, next) =>
              setPicked((current) => {
                const updated = new Set(current);
                if (next) updated.add(value);
                else updated.delete(value);
                return updated;
              })
            }
            disabled={busy}
            testID="admin-encryption-pick"
          />
        )
      ) : null}
      <Text variant="meta" style={styles.foot}>
        Buckets that customers own are never touched.
      </Text>
      {error ? (
        <Text variant="error" role="alert" testID="admin-encryption-start-error">
          {error}
        </Text>
      ) : null}
    </DialogShell>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    foot: { marginTop: -space.x1 },
    actionCompact: { alignSelf: "stretch", paddingVertical: 13, borderRadius: 14 },
  });
