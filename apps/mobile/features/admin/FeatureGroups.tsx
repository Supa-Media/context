/**
 * The Features tab's tester groups (the owner, 2026-11-08: "a dog food or friends and family group"), and the pieces
 * the flag rows share with them: a row of removable names and an "add by handle, email or phone" field.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Text, TextField, space, useThemedStyles } from "../design";
import { EmptyNote, Panel } from "./AdminKit";
import { messageFor } from "./SecretDialogs";

/** One change at a time, with the server's refusal in words. */
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function act(run: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    try {
      await run();
      return true;
    } catch (error: unknown) {
      setProblem(messageFor(error, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, problem, act };
}

type Act = ReturnType<typeof useAct>["act"];

export function PersonChips({
  people,
  empty,
  act,
  busy,
  testID,
}: {
  people: { key: string; name: string; onRemove: () => Promise<unknown> }[];
  empty: string;
  act: Act;
  busy: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  if (people.length === 0) return <Text variant="meta">{empty}</Text>;
  return (
    <View style={styles.chips} testID={testID}>
      {people.map((p) => (
        <Button
          key={p.key}
          label={`${p.name}  ×`}
          accessibilityLabel={`Remove ${p.name}`}
          disabled={busy}
          onPress={() => void act(p.onRemove, "That was not removed. Try again.")}
          testID={`${testID}-remove-${p.name}`}
        />
      ))}
    </View>
  );
}

export function AddByName({ label, busy, onAdd, testID }: { label: string; busy: boolean; onAdd: (who: string) => Promise<boolean>; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const [who, setWho] = useState("");
  async function submit() {
    const typed = who.trim();
    if (typed === "") return;
    if (await onAdd(typed)) setWho("");
  }
  return (
    <View style={styles.add}>
      <TextField
        label={label}
        labelHidden
        placeholder="@handle, email or phone"
        value={who}
        onChangeText={setWho}
        onSubmitEditing={() => void submit()}
        autoCapitalize="none"
        autoCorrect={false}
        containerStyle={styles.field}
        testID={`${testID}-field`}
      />
      <Button label="Add" disabled={busy || who.trim() === ""} onPress={() => void submit()} testID={`${testID}-button`} />
    </View>
  );
}

type Group = { groupId: string; name: string; people: { userId: string; name: string }[] };

export function TesterGroupsPanel({ groups }: { groups: Group[] }) {
  const styles = useThemedStyles(makeStyles);
  const create = useMutation(api.functions.featureFlags.createTesterGroup);
  const { busy, problem, act } = useAct();
  return (
    <Panel title="Tester groups" help="People you test with often. Add a group to a flag and everyone in it has the flag, now and as they join.">
      {groups.length === 0 ? <EmptyNote title="No groups yet" body="Make one, such as Dogfood or Friends and family." testID="admin-groups-empty" /> : null}
      {groups.map((g) => (
        <GroupRow key={g.groupId} group={g} />
      ))}
      <View style={styles.group}>
        <AddByName label="New group's name" busy={busy} onAdd={(name) => act(() => create({ name }), "That group was not made.")} testID="admin-group-create" />
        {problem === null ? null : <Text variant="meta">{problem}</Text>}
      </View>
    </Panel>
  );
}

function GroupRow({ group }: { group: Group }) {
  const styles = useThemedStyles(makeStyles);
  const addPerson = useMutation(api.functions.featureFlags.addGroupPerson);
  const removePerson = useMutation(api.functions.featureFlags.removeGroupPerson);
  const remove = useMutation(api.functions.featureFlags.deleteTesterGroup);
  const { busy, problem, act } = useAct();
  const groupId = group.groupId as Id<"testerGroups">;
  return (
    <View style={styles.group} testID={`admin-group-${group.name}`}>
      <View style={styles.head}>
        <Text variant="rowTitle">
          {group.name} · {group.people.length} {group.people.length === 1 ? "person" : "people"}
        </Text>
        <Button
          label="Delete group"
          variant="danger"
          disabled={busy}
          onPress={() => void act(() => remove({ groupId }), "That group was not deleted.")}
          testID={`admin-group-${group.name}-delete`}
        />
      </View>
      <PersonChips
        people={group.people.map((p) => ({ key: p.userId, name: p.name, onRemove: () => removePerson({ groupId, userId: p.userId as Id<"users"> }) }))}
        empty="Nobody in it yet."
        act={act}
        busy={busy}
        testID={`admin-group-${group.name}-list`}
      />
      <AddByName label={`Add someone to ${group.name}`} busy={busy} onAdd={(who) => act(() => addPerson({ groupId, who }), "Nobody was added.")} testID={`admin-group-${group.name}-add`} />
      {problem === null ? null : <Text variant="meta">{problem}</Text>}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    add: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    field: { flex: 1, minWidth: 0 },
    group: { gap: space.x2, paddingVertical: space.x3 },
    head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.x2 },
  });
