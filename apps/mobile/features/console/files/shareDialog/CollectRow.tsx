import { useState } from "react";
import { View } from "react-native";
import { Text } from "../../../design/components/Text";
import { Switch } from "../../../design/components/Switch";
import { useThemedStyles } from "../../../design/theme";
import type { NoteShare } from "../shares";
import { makeStyles } from "./styles";

/**
 * Answer-taking: the one switch on this screen that hands out a WRITE.
 *
 * ## Why it is drawn here and not beside the audience control
 *
 * The audience control decides who can *reach* the note. This decides what
 * they can *do* when they get there, and it only exists once a link does — so
 * it belongs under the link it modifies, next to Copy and Revoke, rather than
 * as a fourth position on a control about reach.
 *
 * ## Only an `anyone` link over a note
 *
 * A workspace link already has readers with accounts, and a form on one is
 * answered under their own handle. A folder link reaches a subtree, and
 * collecting through one would publish every form beneath it on the strength
 * of one decision. Both are refused by the server; what this does is not draw
 * a switch that is going to be refused.
 *
 * ## The sentence under it is not decoration
 *
 * Everything else in this dialog gives somebody a read. This lets a stranger
 * with no account append to a file in the owner's own bucket — which is the
 * feature, and which they have to be told in the same breath rather than in a
 * help page. So the copy says the three things: who can send, that nobody can
 * read the answers through it, and that an answer cannot be taken back.
 */
export function CollectRow({
  share,
  onSetCollecting,
}: {
  share: NoteShare;
  onSetCollecting: (shareId: string, collecting: boolean) => Promise<boolean>;
}) {
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  /*
    The switch shows what the SERVER said, except while a press is in flight.

    `share.collecting` is re-read from `listShares` on every render, so the
    optimistic value is dropped the moment the real one arrives — and a refusal
    leaves the switch where it was rather than where somebody put it.
  */
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? share.collecting;

  const flip = (next: boolean) => {
    setPending(next);
    setBusy(true);
    void onSetCollecting(share.shareId, next)
      .then((ok) => {
        if (!ok) setPending(null);
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.linkRow} testID="share-collect-row">
      <View style={styles.linkMain}>
        <Text variant="rowTitle">Take answers</Text>
        <Text variant="meta" style={styles.linkNote}>
          {on
            ? "Anyone holding this link can fill in a form on this note without an account. " +
              "Nobody can read the answers through it, and an answer cannot be taken back."
            : "Let anyone holding this link fill in a form on this note, without an account."}
        </Text>
      </View>
      <Switch
        value={on}
        onValueChange={flip}
        label="Take answers through this link"
        disabled={busy}
        testID="share-collect-switch"
      />
    </View>
  );
}
