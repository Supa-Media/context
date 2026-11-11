/**
 * The Features tab's tester groups (the owner, 2026-11-08: "a dog food or friends and family group"). Each group is a
 * plain row of people; with none, one line and "+ New group", never an empty box (the owner, 2026-11-11).
 */

import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Text, fonts, space, useColors, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useFieldFont } from "../design/fieldFont";
import { ChipLine, LinkButton, Row, Section, useAct } from "./FeatureKit";

type Group = { groupId: string; name: string; people: { userId: string; name: string }[] };

export function TesterGroupsPanel({ groups }: { groups: Group[] }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.meta + 1);
  const create = useMutation(api.functions.featureFlags.createTesterGroup);
  const { busy, problem, act } = useAct();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const close = () => {
    setNaming(false);
    setName("");
  };
  async function submit() {
    const typed = name.trim();
    if (typed === "") return;
    if (await act(() => create({ name: typed }), "That group was not made.")) close();
  }
  return (
    <Section
      title="Tester groups"
      aside={naming ? undefined : <LinkButton label="+ New group" onPress={() => setNaming(true)} testID="admin-group-create-open" />}
      testID="admin-groups"
    >
      {naming ? (
        <Row>
          <View style={styles.newRow}>
            <TextInput
              accessibilityLabel="New group's name"
              autoFocus
              value={name}
              onChangeText={setName}
              onSubmitEditing={() => void submit()}
              onKeyPress={(e) => (e.nativeEvent.key === "Escape" ? close() : undefined)}
              placeholder="Name, such as Dogfood"
              placeholderTextColor={colors.muted}
              editable={!busy}
              style={[styles.field, fieldFont]}
              testID="admin-group-create-field"
            />
            <LinkButton label="Make group" disabled={busy || name.trim() === ""} onPress={() => void submit()} testID="admin-group-create-button" />
            <LinkButton label="Cancel" quiet onPress={close} testID="admin-group-create-cancel" />
          </View>
          {problem === null ? null : <Text variant="meta" style={styles.problem}>{problem}</Text>}
        </Row>
      ) : null}
      {groups.length === 0 && !naming ? (
        <Row testID="admin-groups-empty">
          <Text variant="meta">No groups yet. A group, such as Dogfood, turns a flag on for several people at once.</Text>
        </Row>
      ) : null}
      {groups.map((g) => (
        <GroupRow key={g.groupId} group={g} />
      ))}
    </Section>
  );
}

function GroupRow({ group }: { group: Group }) {
  const styles = useThemedStyles(makeStyles);
  const addPerson = useMutation(api.functions.featureFlags.addGroupPerson);
  const removePerson = useMutation(api.functions.featureFlags.removeGroupPerson);
  const remove = useMutation(api.functions.featureFlags.deleteTesterGroup);
  const { busy, problem, act } = useAct();
  const groupId = group.groupId as Id<"testerGroups">;
  const count = group.people.length;
  return (
    <Row testID={`admin-group-${group.name}`}>
      <View style={styles.head}>
        <Text variant="rowTitle" style={styles.shrink}>
          {group.name}
          <Text variant="meta"> · {count} {count === 1 ? "person" : "people"}</Text>
        </Text>
        <LinkButton label="Delete group" quiet disabled={busy} onPress={() => void act(() => remove({ groupId }), "That group was not deleted.")} testID={`admin-group-${group.name}-delete`} />
      </View>
      <ChipLine
        chips={group.people.map((p) => ({ key: p.userId, name: p.name, onRemove: () => removePerson({ groupId, userId: p.userId as Id<"users"> }) }))}
        addLabel={`Add someone to ${group.name}`}
        placeholder="@handle, email or phone"
        onAdd={(who) => act(() => addPerson({ groupId, who }), "Nobody was added.")}
        act={act}
        busy={busy}
        testID={`admin-group-${group.name}-list`}
      />
      {problem === null ? null : <Text variant="meta" style={styles.problem}>{problem}</Text>}
    </Row>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.x3 },
    shrink: { flexShrink: 1 },
    newRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
    field: {
      height: 28,
      width: 240,
      maxWidth: "100%",
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 7,
      fontFamily: fonts.body,
      fontSize: pointerType.meta + 1,
      color: colors.text,
      outlineStyle: "none",
    } as object,
    problem: { color: colors.critText },
  });
