import { View } from "react-native";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { makeStyles } from "./styles";

/**
 * `privacy.md` gets an explanation rather than a disabled cursor.
 *
 * Somebody who opens it is trying to find out how sharing works. Telling them
 * where the switch actually is answers that; greying the file out does not.
 */
/**
 * What an encrypted note says in place of an editor.
 *
 * It has to answer three questions in the order somebody asks them: what is
 * this, why can I not type in it, and who *can* read it. The third is the one
 * this product must not fudge — the note is readable through Context by
 * everyone its visibility already reaches, and saying "only you" would be
 * false. See `docs/decisions/encryption.md`, "What we can still read, and
 * saying so".
 */
export function EncryptedNotice() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.notice}>
      <Text variant="hint">
        This note is encrypted. Its content is stored as ciphertext in your bucket, so
        your storage provider cannot read it and neither can a stolen bucket key — and
        neither can this editor, which is why what is shown below is the envelope rather
        than the note. It stays readable through a connected client to everyone its
        visibility already reaches, and it is not searchable while it is encrypted.
      </Text>
    </View>
  );
}

export function ManifestNotice() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.notice}>
      <Text variant="hint">
        This file is generated from your visibility settings and is read-only here. To
        change what a client can see, use the visibility control beside a file or folder
        in the tree — this file is rewritten to match. Editing{" "}
        <Text variant="hint" style={styles.noticeStrong}>
          visibility:
        </Text>{" "}
        in a note&apos;s own frontmatter changes nothing: frontmatter describes a note,
        this file decides access.
      </Text>
    </View>
  );
}
