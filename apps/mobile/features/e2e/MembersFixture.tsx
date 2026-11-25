import { ScrollView, StyleSheet, View } from "react-native";
import { MembersSection } from "../console/members/MembersSection";
import type { MembersView } from "../console/members/members";
import { useThemedStyles, type Colors } from "../design/theme";

/**
 * Settings › People with an owner, a co-owner, editors and a viewer, for
 * screenshots: `/e2e-fixture?screen=members`, as the owner; `at=co-owner` draws
 * it as the co-owner. Every name and address is invented, and every action
 * only resolves, so nothing reaches an account.
 */
export function MembersFixture({ asCoOwner }: { asCoOwner: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const done = async () => {};
  const view: MembersView = {
    loading: false,
    failure: null,
    members: [
      { userId: "u1", role: "owner", isOwner: true, name: "Avery Example-Lindqvist", email: "avery@example.com", joinedAt: 0, isMe: !asCoOwner },
      { userId: "u2", role: "owner", isOwner: false, name: "Sam Rivera", email: "sam.rivera@example.com", joinedAt: 1, isMe: asCoOwner },
      { userId: "u3", role: "editor", name: "Jordan Okonkwo-Barrington", email: "jordan.okonkwo-barrington@example.com", joinedAt: 2, isMe: false },
      { userId: "u4", role: "member", name: "Lee Park", email: "lee@example.com", joinedAt: 3, isMe: false },
    ],
    invitations: [],
    actions: {
      invite: done,
      remove: done,
      setRole: done,
      withdraw: done,
      setOwnerRole: done,
      handOver: done,
      iAmOwner: !asCoOwner,
      coOwnersAllowed: true,
    },
  };
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.column}>
        <MembersSection view={view} />
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flexGrow: 1, backgroundColor: colors.ground, paddingVertical: 40, paddingHorizontal: 16, alignItems: "center" },
    column: { width: "100%", maxWidth: 640 },
  });
