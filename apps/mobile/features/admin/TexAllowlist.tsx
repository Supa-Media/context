/**
 * Who can text Tex: the Linq shared line's contact list (Dev2, 2026-10-13).
 *
 * Linq's free line forwards a text only from a number on its list, twenty at
 * most; anybody else gets silence and leaves no trace on our side. So the
 * panel shows the slots used, whose each number is, adds a number (refusing a
 * twenty-first with a sentence) and frees a slot. Linq keeps the list, so
 * this reads it fresh rather than from a copy of ours (`texAllowlist` in
 * `apps/convex/functions/lib/adminFns/texAllowlist.ts`).
 */

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button, Text, TextField, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, Panel, Skeleton, useCompact } from "./AdminKit";
import { ListRow } from "./AdminTable";
import { messageFor } from "./SecretDialogs";
import { changeSentence, personLine, slotsLine, type TexChange, type TexPerson } from "./texAllowlist";

type Line =
  | { state: "not_connected" }
  | { state: "error"; error: string }
  | { state: "unlimited"; line: string | null }
  | {
      state: "shared";
      line: string | null;
      cap: number;
      contacts: { phone: string; addedAt: number | null; person: TexPerson }[];
    };

function addedOn(at: number | null): string | null {
  return at === null ? null : `added ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function TexAllowlist() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const read = useAction(api.functions.admin.texAllowlist);
  const change = useAction(api.functions.admin.changeTexAllowlist);
  const [line, setLine] = useState<Line | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLine((await read({})) as Line);
    } catch (caught) {
      setLine({ state: "error", error: messageFor(caught, "The list could not be read. Try again.") });
    }
  }, [read]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(typed: string, kind: "add" | "remove") {
    setBusy(`${kind}:${typed}`);
    setSaid(null);
    try {
      const result = (await change({ phone: typed, change: kind })) as TexChange;
      setSaid(changeSentence(result));
      if (result.status === "added") setPhone("");
      setConfirming(null);
      await refresh();
    } catch (caught) {
      setSaid({ text: messageFor(caught, "That did not work. Try again."), error: true });
    } finally {
      setBusy(null);
    }
  }

  const meta = line?.state === "shared" ? slotsLine(line.contacts.length, line.cap) : undefined;
  return (
    <Panel title="Who can text Tex" meta={meta} testID="admin-tex-allowlist">
      {line === null ? (
        <Skeleton width="100%" height={48} />
      ) : line.state === "not_connected" ? (
        <EmptyNote
          title="Linq isn't connected here"
          body="This deployment has no LINQ_API_KEY, so the list can't be read. The deploy sets it from GitHub."
        />
      ) : line.state === "error" ? (
        <View style={styles.body}>
          <Text variant="error" role="alert" testID="admin-tex-allowlist-error">
            {line.error}
          </Text>
          <View style={styles.actions}>
            <Button label="Try again" variant="dialog" onPress={() => void refresh()} />
          </View>
        </View>
      ) : line.state === "unlimited" ? (
        <Text variant="meta">This Linq line has no contact list: anybody can text Tex.</Text>
      ) : (
        <View style={styles.body}>
          <Text variant="meta" style={styles.note}>
            Linq’s free line only passes on texts from these numbers{line.line ? ` to ${line.line}` : ""}. Anyone else gets no
            answer. A new number has to text Tex first.
          </Text>
          <View style={[styles.add, compact && styles.addCompact]}>
            <TextField
              label="Phone number"
              labelHidden
              value={phone}
              onChangeText={setPhone}
              placeholder="+1 555 555 0100"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="phone-pad"
              containerStyle={styles.field}
              onSubmitEditing={() => phone.trim() !== "" && void run(phone, "add")}
              testID="admin-tex-allowlist-phone"
            />
            <Button
              label={busy?.startsWith("add:") ? "Adding…" : "Add"}
              variant="dialogPrimary"
              disabled={busy !== null || phone.trim() === "" || line.contacts.length >= line.cap}
              onPress={() => void run(phone, "add")}
              testID="admin-tex-allowlist-add"
            />
          </View>
          {said ? (
            <Text variant={said.error ? "error" : "meta"} role={said.error ? "alert" : undefined} testID="admin-tex-allowlist-said">
              {said.text}
            </Text>
          ) : null}
          {line.contacts.length === 0 ? (
            <EmptyNote title="Nobody yet" body={`Add up to ${line.cap} numbers.`} />
          ) : (
            <View>
              {line.contacts.map((contact, i) => (
                <ListRow
                  key={contact.phone}
                  first={i === 0}
                  title={<Text variant="mono">{contact.phone}</Text>}
                  sub={[personLine(contact.person), addedOn(contact.addedAt)].filter(Boolean).join(" · ")}
                  trailing={
                    confirming === contact.phone ? (
                      <View style={styles.actions}>
                        <Button label="Keep" variant="dialog" disabled={busy !== null} onPress={() => setConfirming(null)} />
                        <Button
                          label={busy === `remove:${contact.phone}` ? "Removing…" : "Remove"}
                          variant="danger"
                          disabled={busy !== null}
                          onPress={() => void run(contact.phone, "remove")}
                          testID="admin-tex-allowlist-remove-confirm"
                        />
                      </View>
                    ) : (
                      <Button
                        label="Remove"
                        accessibilityLabel={`Remove ${contact.phone}`}
                        variant="dialog"
                        disabled={busy !== null}
                        onPress={() => setConfirming(contact.phone)}
                        testID="admin-tex-allowlist-remove"
                      />
                    )
                  }
                  testID="admin-tex-allowlist-row"
                />
              ))}
            </View>
          )}
        </View>
      )}
    </Panel>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { gap: space.x3 },
    note: { color: colors.text2 },
    add: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    addCompact: { flexDirection: "column", alignItems: "stretch" },
    field: { flex: 1 },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
  });
