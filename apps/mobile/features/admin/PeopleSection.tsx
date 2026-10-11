/**
 * The People tab: look somebody up, see who they are, type in their phone.
 *
 * Dev2 (2026-10-09), before sign-in moves to phone numbers: staff know almost
 * everybody's number, so they type it here. Each person is a card: their
 * name and @username, every address they sign in with (the first is where
 * mail goes), their phone, and every workspace they reach with their role.
 *
 * Control-plane metadata only, like the rest of the console: nothing here
 * names a note. A phone saved here counts as confirmed; one phone is one
 * person, so a number somebody else holds is refused with who holds it.
 *
 * Archive hides an account (test accounts, mostly) from this list and from
 * Growth's figures. It deletes nothing and can be undone from Archived.
 */

import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Card, Pill, Text, TextField, leading, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { EmptyNote, Skeleton, useCompact } from "./AdminKit";
import { Segments } from "./Segments";
import { messageFor } from "./SecretDialogs";
import { joinedLabel, phoneSentence, roleLabel, type PersonRole, type PhoneResult } from "./people";

/** Waits this long after the last key before asking the server. */
const SEARCH_PAUSE_MS = 250;

const VIEWS = [
  { key: "active", label: "People" },
  { key: "archived", label: "Archived" },
] as const;
type PeopleView = (typeof VIEWS)[number]["key"];

interface Person {
  userId: Id<"users">;
  name: string | null;
  username: string | null;
  emails: string[];
  phone: string | null;
  textingPhones: string[];
  joinedAt: number;
  archived: boolean;
  workspaces: { slug: string; name: string; kind: "personal" | "shared"; role: PersonRole }[];
}

export function PeopleSection() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  const [view, setView] = useState<PeopleView>("active");
  const people = useQuery(api.functions.admin.listPeople, { search, archived: view === "archived" });

  return (
    <View style={styles.section}>
      <View style={styles.titles}>
        <Text variant="rowTitle" role="heading" aria-level={2} style={styles.title}>
          People
        </Text>
        <Text variant="meta" style={compact ? styles.textCompact : null}>
          Find someone by name, email, @username or phone. A phone you type here counts as confirmed.
        </Text>
      </View>
      <TextField
        label="Search"
        labelHidden
        value={typed}
        onChangeText={setTyped}
        placeholder="Name, email, @username or phone"
        autoCapitalize="none"
        autoCorrect={false}
        testID="admin-people-search"
      />
      <Segments options={VIEWS} value={view} onChange={setView} label="Which accounts" testID="admin-people-view" />
      {people === undefined ? (
        <View style={styles.list}>
          <Skeleton width="100%" height={140} />
          <Skeleton width="100%" height={140} />
        </View>
      ) : people.length === 0 ? (
        <EmptyNote
          title={
            search !== ""
              ? `Nobody matches “${search}”.`
              : view === "archived"
                ? "No archived accounts."
                : "No accounts yet."
          }
        />
      ) : (
        <View style={styles.list}>
          {search === "" ? (
            <Text variant="meta">
              {view === "archived"
                ? "Hidden from People and Growth. Nothing was deleted, and they can still sign in."
                : "Newest accounts first."}
            </Text>
          ) : null}
          {people.map((person) => (
            <PersonCard key={person.userId} person={person} />
          ))}
        </View>
      )}
    </View>
  );
}

function PersonCard({ person }: { person: Person }) {
  const styles = useThemedStyles(makeStyles);
  const title = person.name ?? (person.username ? `@${person.username}` : (person.emails[0] ?? "No name"));
  return (
    <Card style={styles.card} testID={`admin-person-${person.userId}`}>
      <View style={styles.headRow}>
        <View style={styles.grow}>
          <Text variant="rowTitle">{title}</Text>
          <Text variant="meta">
            {person.name && person.username ? `@${person.username} · ` : ""}
            {joinedLabel(person.joinedAt)}
          </Text>
        </View>
        <ArchiveButton person={person} />
      </View>

      <Label>Emails</Label>
      {person.emails.length === 0 ? <Text variant="meta">None</Text> : null}
      {person.emails.map((email, index) => (
        <View key={email} style={styles.line}>
          <Text variant="mono" style={styles.grow}>
            {email}
          </Text>
          {index === 0 ? <Pill>Mail goes here</Pill> : null}
        </View>
      ))}

      <Label>Phone</Label>
      <PhoneEditor person={person} />

      <Label>Workspaces</Label>
      {person.workspaces.length === 0 ? <Text variant="meta">None</Text> : null}
      <View style={styles.chips}>
        {person.workspaces.map((workspace) => (
          <Pill key={workspace.slug} tone={workspace.kind === "personal" ? "ok" : "neutral"}>
            {`@${workspace.slug} · ${roleLabel(workspace.role)}`}
          </Pill>
        ))}
      </View>
    </Card>
  );
}

function ArchiveButton({ person }: { person: Person }) {
  const setArchived = useMutation(api.functions.admin.setPersonArchived);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function press() {
    setBusy(true);
    setError(null);
    try {
      const result = await setArchived({ userId: person.userId, archived: !person.archived });
      if (result.status === "self") setError("You can't archive your own account.");
    } catch (caught) {
      setError(messageFor(caught, "That did not work. Try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View>
      <Button
        label={person.archived ? "Unarchive" : "Archive"}
        variant="dialog"
        disabled={busy}
        onPress={() => void press()}
        testID={`admin-person-archive-${person.userId}`}
      />
      {error ? (
        <Text variant="error" role="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function PhoneEditor({ person }: { person: Person }) {
  const styles = useThemedStyles(makeStyles);
  const setPhone = useMutation(api.functions.admin.setPersonPhone);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(person.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(phone: string | null) {
    setBusy(true);
    setSaid(null);
    try {
      const result = (await setPhone({ userId: person.userId, phone })) as PhoneResult;
      const sentence = phoneSentence(result);
      setSaid(sentence);
      if (sentence.ok) {
        setEditing(false);
        setValue(result.status === "saved" ? (result.phone ?? "") : "");
      }
    } catch (caught) {
      setSaid({ ok: false, text: messageFor(caught, "That did not work. Try again.") });
    } finally {
      setBusy(false);
    }
  }

  const texting = person.textingPhones.filter((phone) => phone !== person.phone);
  return (
    <View style={styles.phone}>
      {editing ? (
        <>
          <TextField
            label="Phone"
            labelHidden
            value={value}
            onChangeText={setValue}
            placeholder="+1 415 555 0100"
            keyboardType="phone-pad"
            autoFocus
            editable={!busy}
            onSubmitEditing={() => void save(value)}
            testID={`admin-person-phone-input-${person.userId}`}
          />
          <View style={styles.actions}>
            <Button
              label={busy ? "Saving…" : "Save"}
              variant="dialogPrimary"
              disabled={busy || value.trim() === ""}
              onPress={() => void save(value)}
              testID={`admin-person-phone-save-${person.userId}`}
            />
            {person.phone ? (
              <Button label="Remove" variant="dialog" disabled={busy} onPress={() => void save(null)} />
            ) : null}
            <Button
              label="Cancel"
              variant="dialog"
              disabled={busy}
              onPress={() => {
                setEditing(false);
                setValue(person.phone ?? "");
                setSaid(null);
              }}
            />
          </View>
        </>
      ) : (
        <View style={styles.line}>
          <Text variant={person.phone ? "mono" : "meta"} style={styles.grow}>
            {person.phone ?? "No phone yet"}
          </Text>
          <Button
            label={person.phone ? "Change" : "Add phone"}
            variant="dialog"
            onPress={() => {
              setSaid(null);
              setEditing(true);
            }}
            testID={`admin-person-phone-edit-${person.userId}`}
          />
        </View>
      )}
      {texting.map((phone) => (
        <Text key={phone} variant="meta">
          {`${phone} · texts the assistant`}
        </Text>
      ))}
      {said ? (
        <Text variant={said.ok ? "meta" : "error"} role={said.ok ? undefined : "alert"}>
          {said.text}
        </Text>
      ) : null}
    </View>
  );
}

function Label({ children }: { children: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text variant="eyebrow" style={styles.label}>
      {children}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    titles: { gap: space.x1 },
    title: { color: colors.text },
    textCompact: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    list: { gap: space.x3 },
    card: { padding: space.x4, gap: space.x1 },
    headRow: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    grow: { flex: 1 },
    label: { marginTop: space.x3, color: colors.muted },
    line: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 28 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    phone: { gap: space.x2 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
  });
