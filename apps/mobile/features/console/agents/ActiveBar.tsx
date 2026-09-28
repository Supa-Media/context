import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { AgentStack } from "./AgentList";
import { activeParts, compactCount, peopleActive, type ActivePerson, type AgentActivityView } from "./agentActivity";

/**
 * What the activity bar says: "13 ppl, 2 agents active".
 *
 * One component for both halves, because they are one fact about a workspace
 * (who is working in it now) and Dev2 asked for them on one bar rather than
 * two. Each half is a stack and its words; people are circles and agents are
 * rounded squares, the shapes they have in the tree, the note and its pile.
 * Either half is left out when it has nothing to say, and the caller draws no
 * bar at all when both are (`agentsLine` is then `null`).
 *
 * The homepage draws this too, fed its demo numbers, so it is the console's
 * own bar in visitor mode rather than a copy of it.
 */
export function ActiveParts({ view }: { view: AgentActivityView }) {
  const styles = useThemedStyles(sheet);
  const parts = activeParts(view);
  return (
    <View style={styles.parts}>
      {parts.people !== null ? (
        <View style={styles.part}>
          <PersonStack people={view.people ?? []} />
          <Text variant="treeMeta" numberOfLines={1} style={styles.words}>
            {parts.people}
          </Text>
        </View>
      ) : null}
      {parts.agents !== null ? (
        <View style={styles.part}>
          <AgentStack agents={view.agents} />
          <Text variant="treeMeta" numberOfLines={1} style={styles.words}>
            {parts.agents}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The people half of the bar's list: one row per person with the workspace
 * open, the viewer marked "You", and how many more when the gateway named
 * fewer than it counted. Rows open nothing: an open console is not in any
 * one note, so there is nowhere to take the reader.
 */
export function PeopleList({ view }: { view: AgentActivityView }) {
  const styles = useThemedStyles(sheet);
  const count = peopleActive(view);
  if (count === null) return null;
  const people = view.people ?? [];
  const more = count - people.length;
  return (
    <View style={styles.list} testID="active-people-list">
      {people.map((person) => (
        <View key={person.id} style={styles.row} accessibilityLabel={person.self ? `${person.name}, you` : person.name}>
          <View style={[styles.rowFace, person.color === null ? styles.faceUnknown : { backgroundColor: person.color }]} />
          <Text variant="tree" numberOfLines={1} style={styles.name}>
            {person.name}
          </Text>
          <Text variant="treeMeta" numberOfLines={1} style={styles.meta}>
            {person.self ? "You" : "Here now"}
          </Text>
        </View>
      ))}
      {more > 0 ? (
        <Text variant="treeMeta" style={[styles.meta, styles.more]}>
          {`and ${compactCount(more)} more`}
        </Text>
      ) : null}
    </View>
  );
}

/** Up to three people as overlapping circles, other people first. */
export function PersonStack({ people }: { people: readonly ActivePerson[] }) {
  const styles = useThemedStyles(sheet);
  const shown = [...people.filter((person) => !person.self), ...people.filter((person) => person.self)].slice(0, 3);
  return (
    <View style={styles.stack} aria-hidden>
      {shown.map((person, index) => (
        <View
          key={person.id}
          style={[
            styles.face,
            index === 0 ? null : styles.stacked,
            person.color === null ? styles.faceUnknown : { backgroundColor: person.color },
          ]}
        />
      ))}
    </View>
  );
}

const FACE = 10;

const sheet = (colors: Colors) =>
  StyleSheet.create({
    parts: { flexDirection: "row", alignItems: "center", gap: space.x3, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    part: { flexDirection: "row", alignItems: "center", gap: space.x2, flexShrink: 1, minWidth: 0 },
    words: { flexShrink: 1 },
    stack: { flexDirection: "row", alignItems: "center" },
    face: { width: FACE, height: FACE, borderRadius: FACE / 2 },
    faceUnknown: { backgroundColor: colors.chromeMuted },
    stacked: { marginLeft: -3 },
    list: { paddingTop: space.x1 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingVertical: space.x2, paddingHorizontal: space.x3 },
    rowFace: { width: 14, height: 14, borderRadius: 7, flexShrink: 0 },
    name: { color: colors.text2, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    meta: { color: colors.chromeMuted, flexShrink: 0 },
    more: { paddingVertical: space.x2, paddingHorizontal: space.x3 },
  });
