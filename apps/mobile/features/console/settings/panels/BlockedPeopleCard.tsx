import { StyleSheet, View } from "react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { personLabel } from "../../../report/model";

/**
 * The people this person blocked, each with Unblock.
 *
 * Blocking happens where somebody reached you — "Report or block" on a
 * @shared note or an invitation — so this card only ever lists people who
 * did, and is drawn only when there is somebody on it. Unblocking brings
 * their shares and invitations back; nothing was deleted while they were
 * blocked. See `apps/convex/functions/blocks.ts`.
 *
 * Reads Convex directly, like `MachinesCard`: a block list belongs to the
 * signed-in person, and `"skip"` while signed out keeps the landing page's
 * copy of this overlay from asking.
 */
export function BlockedPeopleCard() {
  const styles = useThemedStyles(makeStyles);
  const { isAuthenticated } = useConvexAuth();
  const people = useQuery(api.functions.blocks.listBlockedPeople, isAuthenticated ? {} : "skip");
  const unblock = useMutation(api.functions.blocks.unblockPerson);

  if (people === undefined || people.length === 0) return null;

  return (
    <View>
      <Text variant="eyebrow" style={styles.head}>
        Blocked people
      </Text>
      <Text variant="rowSub" style={styles.sub}>
        Nothing they share with you or invite you to reaches you. They are not told, and you still see
        them in any workspace you both belong to.
      </Text>
      <Card>
        {people.map((person, index) => {
          const label = personLabel(person);
          return (
            <Row key={person.userId} divided={index > 0}>
              <Grow>
                <Text variant="rowTitle">{label}</Text>
                {person.name !== null && person.handle !== null ? (
                  <Text variant="rowSub" style={styles.rowSub}>
                    {person.name}
                  </Text>
                ) : null}
              </Grow>
              <Button
                label="Unblock"
                accessibilityLabel={`Unblock ${label}`}
                onPress={() => {
                  void unblock({ userId: person.userId }).catch(() => undefined);
                }}
                testID={`unblock-${person.userId}`}
              />
            </Row>
          );
        })}
      </Card>
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    rowSub: { marginTop: 2 },
  });
