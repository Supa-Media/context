import { StyleSheet } from "react-native";
import { Button } from "../../design/components/Button";
import { Grow, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { ConsoleClient } from "../types";

/**
 * One connected AI app, and whose it is.
 *
 * A row that is not yours says so. Only a context's `owner` is shown anybody
 * else's grants at all — `functions/grants.listGrants` narrowed to that after
 * somebody invited into a personal brain found the owner's clients in their
 * own Settings — and what is left is the other half of the same confusion: in
 * a shared context the owner's list holds their colleagues' apps too, under
 * a heading that says every app *you* add appears below, on a card under
 * *your* address. Unmarked, a colleague's Claude is indistinguishable from
 * one of your own, and Revoke beside it is a button that disconnects somebody
 * else's laptop without saying so.
 *
 * It does not name the person. `listGrants` returns a `userId` and no more, and
 * resolving it here would put "who uses which AI app" on a row that only
 * has to answer "is this mine".
 *
 * Its own module rather than an export of `panes/ConnectionsPane`: the
 * settings overlay renders it too, and a settings file reaching into a pane
 * for a shared row is a layering inversion that only held while there was one
 * caller.
 */
export function ClientRow({ client }: { client: ConsoleClient }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Row divided>
      <Dot tone={client.status} />
      <Grow>
        <Row style={styles.rowTitle}>
          <Text variant="rowTitle">{client.name}</Text>
          {client.mine ? null : <Pill tone="neutral">another member&apos;s</Pill>}
        </Row>
        <Text variant="rowSub" style={styles.rowSub}>
          {/* Which context, then what it can do there. */}
          <Text variant="rowSub" style={styles.rowContext}>
            {client.context}
          </Text>
          {` · ${client.detail}`}
        </Text>
      </Grow>
      {/*
        Present in the demo but disabled: the mockup shows a Revoke on every
        row, and hiding it there would misrepresent the design — but a demo
        console must never offer a button that pretends to act.
      */}
      <Button
        label="Revoke"
        variant="danger"
        accessibilityLabel={
          client.mine
            ? `Revoke ${client.name}'s access to ${client.context}`
            : `Revoke another member's ${client.name} access to ${client.context}`
        }
        disabled={client.revoke === undefined}
        onPress={client.revoke}
      />
    </Row>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    rowTitle: { gap: 8 },
    rowSub: { marginTop: 2 },
    rowContext: { color: colors.text2, fontWeight: "600" },
  });
