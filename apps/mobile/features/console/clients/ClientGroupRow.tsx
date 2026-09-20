import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Grow, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Icon } from "../../design/components/Icon";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ClientRow } from "./ClientRow";
import { connectionCount, type ClientGroup } from "./grouped";

/**
 * One AI app, with its grants folded inside it.
 *
 * At rest the row says what somebody scanning the list needs — which app, how
 * many ways it can reach them, which contexts, when it was last used. Opening
 * it shows the individual grants, each with its own Revoke, because cutting
 * off one laptop without cutting off the others is the only reason to look at
 * a grant individually.
 *
 * A group of one opens too rather than being drawn flat, and that is
 * deliberate: a list where some rows expand and others do not is a list a
 * person has to learn, and the row that does not expand is the one they press
 * hardest. Its detail is one row, which is honest.
 */
export function ClientGroupRow({ group }: { group: ClientGroup }) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  return (
    <View>
      <PressRow
        onPress={() => setOpen((value) => !value)}
        ariaExpanded={open}
        accessibilityLabel={`${group.name}, ${connectionCount(group)} in ${group.contexts}. ${
          open ? "Hide" : "Show"
        } each connection.`}
        testID={`client-group-${group.name}`}
      >
        <Row divided style={styles.row}>
          <Dot tone={group.status} />
          <Grow>
            <Row style={styles.title}>
              <Text variant="rowTitle">{group.name}</Text>
              {group.hasOthers ? <Pill tone="neutral">another member&apos;s</Pill> : null}
            </Row>
            <Text variant="rowSub" style={styles.rowSub}>
              <Text variant="rowSub" style={styles.contexts}>
                {group.contexts}
              </Text>
              {` · ${connectionCount(group)} · ${group.detail}`}
            </Text>
          </Grow>
          <Icon name={open ? "chevronUp" : "chevronDown"} size={16} />
        </Row>
      </PressRow>

      {/*
        The grants themselves, unchanged — `ClientRow` is the Connections
        pane's row and stays the one implementation, so a grant's own Revoke,
        its "another member's" chip and its disabled state in the demo cannot
        drift from what that surface shows.
      */}
      {open ? (
        <View style={styles.grants}>
          {group.clients.map((client) => (
            <ClientRow key={client.id} client={client} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { gap: 10 },
    title: { gap: 8 },
    rowSub: { marginTop: 2 },
    contexts: { color: colors.text2, fontWeight: "600" },
    /** Indented, so an open group reads as its own list rather than as more rows. */
    grants: { paddingLeft: 17 },
  });
