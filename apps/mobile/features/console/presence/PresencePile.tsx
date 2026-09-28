import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { PressRow } from "../../design/components/Button";
import { Menu } from "../../design/components/Menu";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { MenuItem } from "../files/menuItem";
import { Icon } from "../../design/components/Icon";
import { FaceView } from "../faces/PersonFace";
import { useFace } from "../faces/useFace";
import { agentName } from "./agentName";
import {
  memberWhere,
  pileFaces,
  pileGeometry,
  presenceLabel,
  presenceListTitle,
  presenceShown,
} from "./pile";
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
 * each person, the colour their caret is drawn in, under their face. People
 * are circles showing their face (`PersonFace`); agents are rounded squares
 * showing their owner's face, or a robot when no owner is in their name.
 * Never initials (Dev2, 2026-09-28).
 */
export function PresencePile({ presence, compact }: { presence: Presence; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const triggerRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
  if (!presenceShown(presence)) return null;

  const reconnecting = presence.phase === "reconnecting";
  const geometry = pileGeometry(compact);
  const { faces, more } = pileFaces(presence.members, geometry.limit);
  // Size and overlap as styles, so a phone's smaller pile is one object.
  const sized = sizeStyle(geometry);
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
              <Face key={member.id} member={member} stacked={index > 0} sized={sized} />
            ))}
            {more > 0 ? (
              <View
                style={[styles.face, sized.face, styles.ring, styles.more, sized.stacked]}
                testID="presence-more"
              >
                <Text variant="treeMeta" style={[styles.moreText, sized.text]}>{`+${more}`}</Text>
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
  sized,
}: {
  member: PresenceMember;
  stacked?: boolean;
  /** The pile's size for this density; the list's own faces take the default. */
  sized?: ReturnType<typeof sizeStyle>;
  /** Off in the list, where the face sits on the menu's surface, not the note. */
  ring?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  // An agent is drawn with whose it is: `@jon's Claude` shows @jon's face.
  const owner = member.isAgent ? agentName(member.name).owner : member.name;
  const face = useFace(owner);
  const size = sized?.face.width ?? FACE;
  return (
    <View
      aria-hidden
      testID="presence-face"
      style={[
        styles.face,
        sized?.face,
        ring ? styles.ring : null,
        // `null` when a peer sent no usable colour; the muted token reads as
        // present and unremarkable rather than as a ninth hue.
        member.color === null ? styles.noColor : { backgroundColor: member.color },
        member.isAgent ? [styles.agent, sized?.agent] : null,
        stacked ? (sized?.stacked ?? styles.stacked) : null,
      ]}
    >
      {owner === null ? (
        <Icon name="robot" size={Math.round(size * 0.6)} color={styles.robot.color} />
      ) : (
        <FaceView
          face={face}
          name={owner}
          size={size}
          style={member.isAgent ? styles.square : null}
          testID="presence-face-inner"
        />
      )}
    </View>
  );
}

const FACE = pileGeometry(false).face;

/**
 * The per-density half of a face's style: its size, its overlap, and what the
 * face can hold.
 *
 * The member's full name is in the list the pile opens, which is where it is
 * read; the face itself carries no text.
 */
function sizeStyle({ face, overlap }: { face: number; overlap: number }) {
  const small = face < FACE;
  return {
    face: { width: face, height: face, borderRadius: face / 2 },
    agent: { borderRadius: Math.round((face * 7) / 24) },
    stacked: { marginLeft: -overlap },
    // For the "+2" face, the one face still drawn in text.
    text: small ? { lineHeight: face - 4 } : null,
  };
}

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
      overflow: "hidden",
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
    robot: { color: c.ink },
    // The outer square clips; the face inside fills it rather than sitting in it as a circle.
    square: { borderRadius: 0 },
    note: { color: c.muted },
  });
