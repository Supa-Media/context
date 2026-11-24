/**
 * Who holds a seat: a person from the workspace, optionally with their agent,
 * or an agent on its own (the owner, 2026-11-24). People are the workspace's
 * members by handle, from the same search an owner menu uses; agents are the
 * workspace's own short list (`agents:`). Owner words merely found in other
 * notes are never offered: they were how "Finance coworker (Grok Bot) for
 * Seyi" and a second `@seyi` ended up beside the real people.
 */

import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { TextField } from "../../../../design/components/Input";
import type { OwnerSearch } from "../../owners";
import { Chip } from "./ReachFields";

export type OwnerKind = "person" | "agent" | "none";

/** What kind of holder an owner word is, for the picker's first row. */
export function ownerKindOf(owner: string, isAgent: (word: string) => boolean): OwnerKind {
  const word = owner.trim();
  if (word === "") return "none";
  return isAgent(word) ? "agent" : "person";
}

interface Person {
  readonly value: string;
  readonly name?: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The workspace's people matching `query`, as the owner search finds them. */
function usePeople(search: OwnerSearch, query: string): readonly Person[] {
  const [people, setPeople] = useState<readonly Person[]>([]);
  useEffect(() => {
    let live = true;
    search(query, [])
      .then((found) => {
        if (live) setPeople(found.people.map((person) => ({ value: person.value, ...(person.name === undefined ? {} : { name: person.name }) })));
      })
      .catch(() => {
        if (live) setPeople([]);
      });
    return () => {
      live = false;
    };
  }, [search, query]);
  return people;
}

export function SeatKindPicker({
  kind,
  canEdit,
  onKind,
}: {
  kind: OwnerKind;
  canEdit: boolean;
  onKind: (kind: OwnerKind) => void;
}) {
  return (
    <View style={styles.chips} role="radiogroup" aria-label="Owner">
      <Chip label="A person" on={kind === "person"} disabled={!canEdit} onPress={() => onKind("person")} testID="seat-owner-person" />
      <Chip label="An agent" on={kind === "agent"} disabled={!canEdit} onPress={() => onKind("agent")} testID="seat-owner-agent" />
      <Chip label="No owner" on={kind === "none"} disabled={!canEdit} onPress={() => onKind("none")} testID="seat-owner-none" />
    </View>
  );
}

export function SeatPersonPicker({
  owner,
  search,
  label,
  canEdit,
  onOwner,
}: {
  owner: string;
  search: OwnerSearch;
  label: (owner: string) => string;
  canEdit: boolean;
  onOwner: (owner: string) => void;
}) {
  const [query, setQuery] = useState("");
  const found = usePeople(search, query);
  const word = owner.trim();
  // The person already chosen stays offered while somebody else is searched for.
  const people = word === "" || found.some((person) => same(person.value, word)) ? found : [{ value: word }, ...found];
  return (
    <>
      <View style={styles.chips} role="radiogroup" aria-label="Person">
        {people.map((person) => (
          <Chip
            key={person.value}
            label={person.name === undefined ? label(person.value) : `${person.name} · ${person.value}`}
            on={same(person.value, word)}
            disabled={!canEdit}
            onPress={() => onOwner(person.value)}
            testID="seat-person"
          />
        ))}
      </View>
      {canEdit ? (
        <TextField
          label="Find someone"
          value={query}
          onChangeText={setQuery}
          placeholder="A name or @handle"
          autoCapitalize="none"
          autoCorrect={false}
          testID="seat-owner-input"
        />
      ) : null}
    </>
  );
}

export function SeatAgentPicker({
  value,
  agents,
  label,
  canEdit,
  noneLabel,
  fieldLabel,
  onAgent,
  testID,
}: {
  value: string;
  agents: readonly string[];
  label: (owner: string) => string;
  canEdit: boolean;
  /** Offered first when choosing no agent is allowed (a person's agent is optional). */
  noneLabel?: string;
  fieldLabel: string;
  onAgent: (agent: string) => void;
  testID: string;
}) {
  const word = value.trim();
  const offered = word === "" || agents.some((agent) => same(agent, word)) ? agents : [word, ...agents];
  return (
    <>
      <View style={styles.chips} role="radiogroup" aria-label={fieldLabel}>
        {noneLabel === undefined ? null : <Chip label={noneLabel} on={word === ""} disabled={!canEdit} onPress={() => onAgent("")} />}
        {offered.map((agent) => (
          <Chip key={agent} label={label(agent)} on={same(agent, word)} disabled={!canEdit} onPress={() => onAgent(agent)} testID={`${testID}-chip`} />
        ))}
      </View>
      {canEdit ? (
        <TextField
          label={`Another ${fieldLabel.toLowerCase()}`}
          value={agents.some((agent) => same(agent, word)) ? "" : value}
          onChangeText={onAgent}
          placeholder="An agent's name"
          autoCapitalize="none"
          autoCorrect={false}
          testID={testID}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
