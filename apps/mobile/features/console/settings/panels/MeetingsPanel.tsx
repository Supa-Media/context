import { StyleSheet } from "react-native";

import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { atName } from "../../format";
import { selectedContext, type ConsoleData } from "../../types";
/*
  Component and constants by their own paths rather than the meetings barrel:
  that barrel re-exports `useMeetingFlow`, which imports `expo-router`, and a
  navigator has no business in a settings panel. `destination.ts` and
  `DestinationSheet.tsx` are both free of it.
*/
import { ThisMachineCard } from "../../../meetings/components/ThisMachineCard";
import { AUDIO_SENTENCE } from "../../../meetings/components/DestinationSheet";
import { loadedFolders } from "../../files/browser";
import { MeetingsDestination } from "./MeetingsDestination";
import { PanelHead } from "./PanelHead";

/**
 * Meetings: recording on this Mac, and where the notes land.
 *
 * **The one panel of the four that is not a refusal on a workspace**, and the
 * reason is a rule rather than an oversight. A mailbox, a calendar and a chat
 * history belong to a person and cannot be attached to a shared bucket at all.
 * A meeting *note* is different: `features/meetings/destination.ts` offers the
 * context you are looking at as a real second choice, with its audience named
 * on the row. So a workspace has a true answer here — "meetings can land here,
 * and they do not by default" — where the other three have only a wall.
 *
 * What is still personal-only is **this Mac**. The machine card is a
 * machine-level thing, and the grant it draws was minted for whichever context
 * the control plane resolved rather than for whichever context the console
 * happens to be showing. Drawing it under a workspace's heading would let a
 * reader conclude that this laptop sends its recordings *there*, which is the
 * exact failure `destination.ts` exists to prevent, arriving through a
 * settings panel instead of through a record button.
 *
 * There is no control on the "where they land" card, and that is honest rather
 * than unfinished: the destination is asked for **every time**, before the
 * microphone opens, precisely so that no remembered setting can answer it
 * silently. A switch here would be a fourth place that decision could be made
 * from.
 */
export function MeetingsPanel({
  data,
  sectioned,
}: {
  data: ConsoleData;
  sectioned: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const current = selectedContext(data);
  const personal = current?.kind === "personal";

  return (
    <>
      <PanelHead section="meetings" sectioned={sectioned}>
        {/*
          "in the desktop app", because the machine card below is absent in a
          browser and on a phone — where this sentence would otherwise be
          describing a card the reader cannot see. The second half is true in
          every runtime: the destination question is asked wherever you record.
        */}
        {personal
          ? "In the desktop app, your Mac records with no window open. The notes land wherever you send them, and you are asked before the microphone opens."
          : "A meeting can be filed here, and it never is by default — you are asked every time, before the microphone opens."}
      </PanelHead>

      {personal ? <ThisMachineCard focus="meetings" /> : null}

      {/*
        A control, where there used to be a paragraph.

        This block read `The first offer is always your own workspace, in
        ${INBOX_FOLDER}` — a constant, interpolated into prose, with nothing
        beside it. Email, Calendar and Chat each let somebody choose where
        their captures land; meetings was the one that did not, and the
        docstring above defended that with the "asked every time" rule, which
        is about a different question. It still holds: the sheet asks before
        every recording. What is settable is the folder the first offer names.
      */}
      <MeetingsDestination
        workspaceId={current?.id ?? null}
        slug={atName(current?.slug ?? "this context")}
        kind={current?.kind ?? "personal"}
        role={current?.role}
        folder={current?.meetingsFolder}
        folders={loadedFolders(data.files.listings)}
      />

      <Text variant="foot" style={styles.audio}>
        {AUDIO_SENTENCE}
      </Text>
    </>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    audio: { marginTop: 12, maxWidth: 546 },
  });
