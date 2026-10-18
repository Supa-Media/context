/**
 * Tex access, per account, on the Growth tab's roster (Dev2, 2026-10-13: "it
 * should be a toggle I can set in the growth tab connected to their account").
 *
 * Linq's free shared line forwards a text only from a number on its contact
 * list, twenty at most. The switch on an account's row puts that account's
 * phone on the list or takes it off. Linq keeps the list, so the roster reads
 * it once with `texAllowlist` and changes it with `changeTexAllowlist`
 * (`apps/convex/functions/lib/adminFns/texAllowlist.ts`); a number on the list
 * that is nobody's account is listed under the roster so its slot can be freed,
 * and a number with no account yet (a friend Dev2 hands Tex's contact to) can be
 * typed in there, because a number off the list is never delivered to us at all.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button, Text, TextField, useThemedStyles, type Colors } from "../design";
import { Switch } from "../design/components/Switch";
import { pointerType } from "../design/tokens";
import { messageFor } from "./SecretDialogs";
import { changeSentence, slotsLine, type TexChange } from "./texAllowlist";

type Line =
  | { state: "not_connected" }
  | { state: "error"; error: string }
  | { state: "unlimited"; line: string | null }
  | {
      state: "shared";
      line: string | null;
      cap: number;
      contacts: { phone: string; addedAt: number | null; person: unknown }[];
    };

interface TexAccess {
  line: Line | null;
  /** Numbers on the list, when there is a list. */
  listed: ReadonlySet<string>;
  full: boolean;
  busy: string | null;
  said: { text: string; error: boolean } | null;
  set: (phone: string, on: boolean) => Promise<void>;
}

const TexContext = createContext<TexAccess | null>(null);

/** Reads Linq's list once for the roster below it. */
export function TexAccessProvider({ children }: { children: ReactNode }) {
  const read = useAction(api.functions.admin.texAllowlist);
  const change = useAction(api.functions.admin.changeTexAllowlist);
  const [line, setLine] = useState<Line | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLine((await read({})) as Line);
    } catch (caught) {
      setLine({ state: "error", error: messageFor(caught, "Tex's list could not be read.") });
    }
  }, [read]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const set = useCallback(
    async (phone: string, on: boolean) => {
      setBusy(phone);
      setSaid(null);
      try {
        const result = (await change({ phone, change: on ? "add" : "remove" })) as TexChange;
        setSaid(changeSentence(result));
        await refresh();
      } catch (caught) {
        setSaid({ text: messageFor(caught, "That did not work. Try again."), error: true });
      } finally {
        setBusy(null);
      }
    },
    [change, refresh],
  );

  const value = useMemo<TexAccess>(() => {
    const listed = new Set(line?.state === "shared" ? line.contacts.map((c) => c.phone) : []);
    const full = line?.state === "shared" && line.contacts.length >= line.cap;
    return { line, listed, full, busy, said, set };
  }, [line, busy, said, set]);

  return <TexContext.Provider value={value}>{children}</TexContext.Provider>;
}

function useTex(): TexAccess | null {
  return useContext(TexContext);
}

const NONE: ReadonlySet<string> = new Set();

/** Numbers on Tex's list, for sorting by the Tex access column. */
export function useTexListed(): ReadonlySet<string> {
  return useTex()?.listed ?? NONE;
}

/** The roster header's words for the list: slots used, or why there is no switch. */
export function useTexMeta(): string | null {
  const tex = useTex();
  const line = tex?.line;
  if (!line) return null;
  if (line.state === "shared") return `Tex ${slotsLine(line.contacts.length, line.cap)}`;
  if (line.state === "unlimited") return "Tex: anybody can text";
  if (line.state === "not_connected") return "Tex: Linq not connected";
  return null;
}

/** One account's switch. */
export function TexSwitch({ phone }: { phone: string | null }) {
  const styles = useThemedStyles(makeStyles);
  const tex = useTex();
  const line = tex?.line;
  if (!tex || !line || line.state !== "shared") {
    return <Text style={styles.plain}>{line?.state === "unlimited" ? "open" : "—"}</Text>;
  }
  if (phone === null) return <Text style={styles.plain}>no phone</Text>;
  const on = tex.listed.has(phone);
  return (
    <Switch
      label={`Tex access for ${phone}`}
      value={on}
      disabled={tex.busy !== null || (!on && tex.full)}
      onValueChange={(next) => void tex.set(phone, next)}
      testID="admin-roster-tex"
    />
  );
}

/**
 * Under the roster: what the last switch did, why the list could not be read,
 * the numbers on it that are nobody's account (a friend added in Linq), each
 * with Remove so its slot can be freed, and a field to add a number that has no
 * account yet. Without it a friend could only be let in after signing up with
 * that phone, and until then their texts to Tex vanish before reaching us.
 */
export function TexFootnotes({ accountPhones }: { accountPhones: ReadonlySet<string> }) {
  const styles = useThemedStyles(makeStyles);
  const tex = useTex();
  const [typed, setTyped] = useState("");
  const line = tex?.line;
  if (!tex || !line) return null;
  const shared = line.state === "shared";
  const others = shared ? line.contacts.filter((c) => !accountPhones.has(c.phone)) : [];
  const error = line.state === "error" ? line.error : null;
  if (!shared && !tex.said && !error) return null;
  const add = async () => {
    if (typed.trim() === "") return;
    await tex.set(typed.trim(), true);
    setTyped("");
  };
  return (
    <View style={styles.notes} testID="admin-roster-tex-notes">
      {error ? (
        <Text variant="error" role="alert">
          Tex access: {error}
        </Text>
      ) : null}
      {tex.said ? (
        <Text variant={tex.said.error ? "error" : "meta"} role={tex.said.error ? "alert" : undefined}>
          {tex.said.text}
        </Text>
      ) : null}
      {others.length > 0 ? (
        <>
          <Text variant="meta">Also on Tex’s list, not an account shown here:</Text>
          {others.map((contact) => (
            <View key={contact.phone} style={styles.other}>
              <Text variant="mono" style={styles.grow}>
                {contact.phone}
              </Text>
              <Button
                label={tex.busy === contact.phone ? "Removing…" : "Remove"}
                variant="dialog"
                disabled={tex.busy !== null}
                onPress={() => void tex.set(contact.phone, false)}
                testID="admin-roster-tex-other-remove"
              />
            </View>
          ))}
        </>
      ) : null}
      {shared ? (
        <View style={styles.other}>
          <TextField
            label="Let a number text Tex"
            labelHidden
            placeholder={tex.full ? "All slots used" : "Phone with country code, like +1 555 555 0100"}
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={() => void add()}
            editable={!tex.full && tex.busy === null}
            keyboardType="phone-pad"
            containerStyle={styles.grow}
            testID="admin-roster-tex-add-phone"
          />
          <Button
            label={tex.busy !== null && tex.busy === typed.trim() ? "Adding…" : "Add"}
            variant="dialog"
            disabled={tex.full || tex.busy !== null || typed.trim() === ""}
            onPress={() => void add()}
            testID="admin-roster-tex-add"
          />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    plain: { fontSize: pointerType.meta, color: colors.muted },
    notes: { gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
    other: { flexDirection: "row", alignItems: "center", gap: 8 },
    grow: { flex: 1 },
  });
