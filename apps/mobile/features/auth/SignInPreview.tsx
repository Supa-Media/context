import { StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { fonts, leading, pointerType as t, radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";

/**
 * The picture beside the sign-in form on a wide window: the product while you
 * type your address (A-01), the email we just sent while you wait for it (A-02).
 *
 * Decoration, so it is hidden from assistive tech and never drawn on a phone.
 * Two rules it keeps anyway, because a picture people read is still a claim:
 *
 *  - the email is the one `apps/convex/auth.ts` actually sends — its subject is
 *    "<code> is your Context code" — with the code **masked**. A sample code in
 *    an illustration is a code somebody types.
 *  - the product view is a made-up workspace with made-up paths, never a real
 *    customer's.
 */
export function SignInPreview({ kind, email }: { kind: "product" | "email"; email: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.stage} aria-hidden testID={`signin-preview-${kind}`}>
      <View style={styles.window}>{kind === "product" ? <Product /> : <Email email={email} />}</View>
    </View>
  );
}

function Product() {
  const styles = useThemedStyles(makeStyles);
  const rows: Array<{ label: string; on?: boolean; nested?: boolean }> = [
    { label: "projects" },
    { label: "context-lc", on: true, nested: true },
    { label: "dc-chapter", nested: true },
    { label: "areas" },
    { label: "resources" },
    { label: "index.md" },
    { label: "privacy.md" },
  ];
  return (
    <View style={styles.product}>
      <View style={styles.tree}>
        {rows.map((row) => (
          <Text key={row.label} style={[styles.treeRow, row.nested && styles.nested, row.on && styles.treeOn]}>
            {row.label}
          </Text>
        ))}
      </View>
      <View style={styles.note}>
        <Text style={styles.noteTitle}>Context.LC — build decisions</Text>
        <Text style={styles.noteBody}>Tenancy is bucket-level, never prefix-level. No key namespacing inside a customer bucket…</Text>
        <Text style={styles.noteBody}>A shared context is just a workspace with more than one member.</Text>
        <View style={styles.read}>
          <View style={styles.dot} />
          <Text style={styles.readText}>Claude read this note · 8 seconds ago</Text>
        </View>
      </View>
    </View>
  );
}

function Email({ email }: { email: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.mail}>
      <View style={styles.mailBar}>
        <Text style={styles.mailBarText}>Inbox{email ? ` · ${email}` : ""}</Text>
      </View>
      <View style={styles.mailHead}>
        <Text variant="eyebrow" style={styles.mailLabel}>From</Text>
        <Text style={styles.mailValue}>Context</Text>
        <Text variant="eyebrow" style={[styles.mailLabel, styles.mailGap]}>Subject</Text>
        <Text style={styles.mailValue}>•••••• is your Context code</Text>
      </View>
      <View style={styles.mailBody}>
        <Text style={styles.noteBody}>Enter the six-digit code in the tab you just opened.</Text>
        <View style={styles.codeChip}>
          <Text style={styles.codeChipText}>••••••</Text>
        </View>
        <Text style={styles.mailFoot}>Expires in 10 minutes. If you didn't ask for it, ignore it — nothing has changed.</Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stage: {
      flex: 1,
      backgroundColor: colors.ground,
      borderLeftWidth: 1,
      borderLeftColor: colors.line,
      paddingTop: 44,
      paddingLeft: 44,
      overflow: "hidden",
    },
    window: {
      flex: 1,
      borderTopWidth: 1,
      borderLeftWidth: 1,
      borderColor: colors.line,
      borderTopLeftRadius: radii.card,
      backgroundColor: colors.surface2,
      overflow: "hidden",
    },
    product: { flex: 1, flexDirection: "row" },
    tree: {
      width: 140,
      backgroundColor: colors.well,
      borderRightWidth: 1,
      borderRightColor: colors.line,
      paddingVertical: space.x3,
      paddingHorizontal: space.x2,
      gap: 3,
    },
    treeRow: { fontFamily: fonts.mono, fontSize: t.meta, color: colors.text2, paddingVertical: 4, paddingHorizontal: 6 },
    nested: { paddingLeft: 16 },
    treeOn: { backgroundColor: colors.hintWash, color: colors.text, borderRadius: 4, overflow: "hidden" },
    note: { flex: 1, paddingVertical: space.x4, paddingHorizontal: space.x5, gap: space.x2 },
    noteTitle: { fontSize: t.lede, fontWeight: "600", color: colors.text },
    noteBody: { fontSize: t.meta, color: colors.text2, lineHeight: leading(12, 1.5) },
    read: {
      marginTop: space.x2,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      backgroundColor: colors.hintWash,
      borderRadius: 6,
      paddingVertical: 6,
      paddingHorizontal: space.x2,
      alignSelf: "flex-start",
    },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
    readText: { fontSize: t.label, color: colors.text },
    mail: { flex: 1 },
    mailBar: {
      paddingVertical: space.x2,
      paddingHorizontal: space.x4,
      backgroundColor: colors.well,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    mailBarText: { fontFamily: fonts.mono, fontSize: t.meta, color: colors.muted },
    mailHead: { paddingVertical: space.x4, paddingHorizontal: space.x5, borderBottomWidth: 1, borderBottomColor: colors.line },
    mailLabel: { color: colors.muted },
    mailGap: { marginTop: space.x3 },
    mailValue: { marginTop: 2, fontSize: t.ui, color: colors.text },
    mailBody: { paddingVertical: space.x5, paddingHorizontal: space.x5, gap: space.x3 },
    codeChip: {
      alignSelf: "flex-start",
      backgroundColor: colors.hintWash,
      borderRadius: radii.md,
      paddingVertical: space.x2,
      paddingHorizontal: space.x4,
    },
    codeChipText: { fontFamily: fonts.mono, fontSize: t.h3, color: colors.accent, letterSpacing: 4 },
    mailFoot: { fontSize: t.meta, color: colors.muted },
  });
