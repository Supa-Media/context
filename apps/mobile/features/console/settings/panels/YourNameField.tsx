import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import { useConvex, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { TextField } from "../../../design/components/Input";
import { space } from "../../../design/tokens";

/**
 * "Name" on Settings › Profile: the person's own name on their account, full name included (Dev2, 2026-11-25: a group
 * asked Tex for someone's last name, and the account held only the first name typed at sign-up, with no way to change
 * it). It is what people see beside a note and what Tex tells a group that asks; Tex changes it by text too.
 *
 * Saves when the field is left or Return is pressed, like the workspace's Name on General. Absent where no backend is
 * (the landing page's console, the demo), because `useQuery` throws without one.
 */
export function YourNameField() {
  const convex = useConvex() as ReturnType<typeof useConvex> | undefined;
  if (convex === undefined) return null;
  return <YourNameFieldLive />;
}

function YourNameFieldLive() {
  const convex = useConvex();
  const mine = useQuery(api.functions.accountName.myName, {});
  const saved = mine?.name ?? "";
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => setDraft(saved), [saved]);
  if (mine === undefined || mine === null) return null;

  const save = async () => {
    const next = draft.trim();
    if (next === saved || saving) return;
    if (next === "") {
      setError("Your account needs a name.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await convex.mutation(api.functions.accountName.setMyName, { name: next });
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
      hint={saving ? "Saving…" : "Your full name, as people should see it."}
      containerStyle={styles.field}
      testID="profile-name"
    />
  );
}

const styles = StyleSheet.create({ field: { width: "100%", marginTop: space.x3 } });
