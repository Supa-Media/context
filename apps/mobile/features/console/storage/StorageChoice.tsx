import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { ConnectForm } from "./ConnectForm";
import { DropboxCard } from "./DropboxCard";
import { useDropboxStart } from "./useDropboxStart";
import type { ConnectFormValues } from "./connect";

/**
 * The two ways to give a context somewhere to keep its notes, on one screen.
 *
 * **Both, at once, neither hidden.** Not a segmented control with one path
 * behind a tab and not a "advanced" link under the easy one: the choice is a
 * real trade and each side is right for a different person, so burying either
 * would be making the decision for them. Dropbox is first because it is the
 * one that asks nothing of somebody who has never made a bucket; the bucket is
 * underneath in full, with its own heading and its own copy about what happens
 * to the credential.
 *
 * The reason this is a choice at all: R2 wants a payment method before it will
 * hand out a free bucket, and that is the largest wall in the funnel. It is
 * not a reason to stop recommending a bucket to anybody who wants the storage
 * to answer to nobody but them.
 */
export function StorageChoice({
  workspaceId,
  connect,
  onCancel,
  dropboxNote,
}: {
  /** The context being connected. `null` disables the Dropbox button only. */
  workspaceId: string | null;
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  /** Present when this is replacing a binding rather than making the first one. */
  onCancel?: () => void;
  /** One line about what leaving for Dropbox does to the screen this is on. */
  dropboxNote?: string;
}) {
  const dropbox = useDropboxStart(workspaceId);

  return (
    <View style={styles.stack}>
      <DropboxCard
        redirectUri={dropbox.redirectUri}
        state={dropbox.state}
        start={dropbox.start}
        note={dropboxNote}
      />
      <Text variant="foot" style={styles.divider}>
        Or bring storage you own outright. Both keep plain Markdown you can read without
        us; the difference is whose account the bytes sit in, and only one of these lets
        you revoke us at a provider you pay yourself.
      </Text>
      <ConnectForm connect={connect} onCancel={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  divider: { lineHeight: leading(12.5, 1.7), marginTop: 2 },
});
