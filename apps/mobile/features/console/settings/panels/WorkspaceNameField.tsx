import { useState } from "react";
import { StyleSheet } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { TextField } from "../../../design/components/Input";

/**
 * The owner's Name field on Settings › General.
 *
 * Saves when the field is left or Return is pressed, the way a name field in a
 * settings page does, rather than behind a Save button beside one field. The
 * address (`@slug`) is not this: it is the stable name people type and links
 * point at, and `setWorkspaceDisplayName` never moves it.
 *
 * Mounted only where a backend is (see `OverviewPanel`), because `useMutation`
 * throws without one.
 */
export function WorkspaceNameField({ workspaceId, name }: { workspaceId: string; name: string }) {
  const rename = useMutation(api.functions.workspaces.setWorkspaceDisplayName);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const save = async () => {
    const next = draft.trim();
    if (next === name || saving) return;
    if (next === "") {
      setError("A workspace needs a name.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await rename({ workspaceId: workspaceId as Id<"workspaces">, displayName: next });
    } catch (failure) {
      const message = (failure as { data?: { message?: string } })?.data?.message;
      setError(message ?? "That didn’t save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <TextField
      label="Name"
      value={draft}
      onChangeText={(value) => {
        setDraft(value);
        setError(undefined);
      }}
      onBlur={() => void save()}
      onSubmitEditing={() => void save()}
      maxLength={80}
      error={error}
      hint={saving ? "Saving…" : undefined}
      containerStyle={styles.field}
      testID="overview-name"
    />
  );
}

const styles = StyleSheet.create({ field: { maxWidth: 386 } });
