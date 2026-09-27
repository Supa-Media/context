import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { PressRow } from "../../design/components/Button";
import { Menu } from "../../design/components/Menu";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { MenuItem } from "../files/menuItem";
import { agentName, handleInitials } from "./agentName";
import { memberWhere, pileFaces, presenceLabel, presenceListTitle, presenceShown } from "./pile";
import type { Presence } from "./presenceContract";
import type { PresenceMember } from "./protocol";

/**
 * Who else is in this note: a small stack of faces at the end of the note's
 * breadcrumb row, with the names one press away.
 *
 * It sits on a row that is always drawn — the pointer layout's note head and
 * the phone's path band — so somebody arriving adds nothing to the layout and
 * the note never moves. It used to be a row of its own above the title, with a
 * pill naming the same people the avatars showed and then counting them.
 *
 * Pressing it opens the shared `Menu`: a popover on a pointer layout and a
 * sheet on a phone, each row a person, and where they are in the note.
 *
 * **It renders nothing when nobody else is here**, which is almost always, and
 * nothing when presence is unavailable. The faces are the colour the room gave
 * each person, the colour their caret is drawn in; people are circles and
 * agents rounded squares carrying their owner's initials, as in the tree.
 */
export function PresencePile({ presence, compact }: { presence: Presence; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const triggerRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
  if (!presenceShown(presence)) return null;

  const reconnecting = presence.phase === "reconnecting";
  const { faces, more } = pileFaces(presence.members, compact ? 3 : 4);
  const items: MenuItem<string>[] = presence.members.map((member) => ({
    id: member.id,
    label: member.name,
    // Read when the list opens, not on every caret move: the pile itself
    // shows no positions, so there is nothing to keep fresh while it is shut.
    detail: memberWhere(member, presence.shared),
    leading: <Face member={member} ring={false} />,
    testID: `presence-person-${member.id}`,
  }));

  return (
    <>
      <View ref={triggerRef}>
        <PressRow
          accessibilityLabel={presenceLabel(presence)}
          ariaHasPopup="menu"
          ariaExpanded={open}
          radius={radii.pill}
          style={styles.pile}
          hoverStyle={styles.hover}
          disabled={reconnecting || presence.members.length === 0}
          // On the control itself, so a check can read its accessible name.
          testID="presence-pile"
          onPress={() => {
            triggerRef.current?.measureInWindow((x, y, _width, height) => {
              setAnchor({ x, y: y + height + 4 });
            });
            setOpen(true);
          }}
        >
          <View style={[styles.faces, reconnecting && styles.dim]}>
            {faces.map((member, index) => (
              <Face key={member.id} member={member} stacked={index > 0} />
            ))}
            {more > 0 ? (
              <View style={[styles.face, styles.ring, styles.more, styles.stacked]}>
                <Text variant="treeMeta" style={styles.moreText}>{`+${more}`}</Text>
              </View>
            ) : null}
          </View>
          {reconnecting ? (
            <Text variant="meta" style={styles.note}>
              Reconnecting
            </Text>
          ) : null}
        </PressRow>
      </View>
      {open ? (
        <Menu<string>
          items={items}
          title={presenceListTitle(presence)}
          // The homepage's cast is a demonstration. The sheet says so under
          // its heading; the pile's own label says so to a screen reader.
          titleDetail={presence.demo === true ? "A demo, played on this page" : undefined}
          anchor={anchor}
          onSelect={() => undefined}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function Face({
  member,
  stacked = false,
  ring = true,
}: {
  member: PresenceMember;
  stacked?: boolean;
  /** Off in the list, where the face sits on the menu's surface, not the note. */
  ring?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      aria-hidden
      style={[
        styles.face,
        ring ? styles.ring : null,
        // `null` when a peer sent no usable colour; the muted token reads as
        // present and unremarkable rather than as a ninth hue.
        member.color === null ? styles.noColor : { backgroundColor: member.color },
        member.isAgent ? styles.agent : null,
        stacked ? styles.stacked : null,
      ]}
    >
      <Text variant="treeMeta" style={styles.initials}>
        {initialsFor(member.name)}
      </Text>
    </View>
  );
}

/**
 * Two characters from a handle, without its `@` — a pile of faces all reading
 * "@" says how many and nothing else. An agent carries its owner's.
 */
function initialsFor(name: string): string {
  return handleInitials(agentName(name).owner ?? name);
}

const FACE = 24;

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    pile: { flexDirection: "row", alignItems: "center", gap: 6, padding: 2 },
    hover: { backgroundColor: c.surface2 },
    faces: { flexDirection: "row", alignItems: "center" },
    dim: { opacity: 0.45 },
    face: {
      width: FACE,
      height: FACE,
      borderRadius: FACE / 2,
      alignItems: "center",
      justifyContent: "center",
    },
    // The ring is the note's own paper, so an overlap reads as a stack of
    // faces in both themes rather than faces sitting in grey boxes — which is
    // what the chrome's colour drew on a note.
    ring: { borderWidth: 2, borderColor: c.pageSurface },
    agent: { borderRadius: 7 },
    stacked: { marginLeft: -3 },
    noColor: { backgroundColor: c.chromeMuted },
    more: { backgroundColor: c.surface3 },
    moreText: { color: c.muted, fontWeight: "700" },
    initials: { color: c.ink, fontWeight: "700" },
    note: { color: c.muted },
  });
