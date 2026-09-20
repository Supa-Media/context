import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Switch } from "../../../design/components/Switch";
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
import { AUDIO_SENTENCE, MIC_ONLY_SENTENCE } from "../../../meetings/disclosure";
import {
  defaultMachineAudio,
  recallMachineAudio,
  rememberMachineAudio,
} from "../../../meetings/machineAudio";
import { useMeetingsSnapshot } from "../../../meetings/useMeetings";
import { openStore } from "../../../offline/store";
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
 * ## This pane is where the two questions live now
 *
 * There used to be a sheet in front of every recording that asked where the
 * meeting should go and offered the whole-call switch. It is gone — pressing
 * New meeting records — so both answers moved here, which is the trade the
 * owner asked for: *"no need to ask people it will just confuse them"*. The
 * folder is a per-context setting; the machine's own audio is a per-device one,
 * because it is a fact about what this machine can hear rather than about a
 * bucket. The sentence about what happens to the audio is said here too, once,
 * instead of in front of every conversation.
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
          ? "In the desktop app, your Mac records with no window open. New meeting starts recording straight away, and the note lands in the folder below."
          : "Meetings are written into your own context, never into this one — a recording started while you are reading here still lands in your own inbox."}
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

      <MachineAudio />

      <Text variant="foot" style={styles.audio}>
        {AUDIO_SENTENCE}
      </Text>
    </>
  );
}

/**
 * Whether this machine records its own audio as well as the microphone.
 *
 * The destination sheet's switch, moved to the one surface that outlives the
 * sheet. It is **per device**, not per meeting and not per context: what a
 * machine can hear is a fact about the machine, and `machineAudio.ts` carries
 * the default — on where a desktop shell can tap silently, off in a browser
 * where it costs a source picker in front of every recording.
 *
 * Absent where a build cannot do it at all (a phone, a browser with nothing to
 * mix into, a shell macOS will not hand a loopback tap): the mic-only sentence
 * is drawn instead, which is the honest absence rather than a switch that
 * cannot do what it says.
 */
function MachineAudio() {
  const styles = useThemedStyles(makeStyles);
  const capture = useMeetingsSnapshot().capture;
  const store = useMemo(() => openStore(), []);
  const [chosen, setChosen] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void recallMachineAudio(store).then((answer) => {
      if (live) setChosen(answer);
    });
    return () => {
      live = false;
    };
  }, [store]);

  const on = chosen ?? defaultMachineAudio(capture.systemAudioNeedsPicker);

  const toggle = useCallback(
    (next: boolean) => {
      // Set here and written behind it: the switch answers the press, and a
      // device that cannot store the answer still records the way it says.
      setChosen(next);
      void rememberMachineAudio(store, next);
    },
    [store],
  );

  if (!capture.systemAudio) {
    return (
      <Text variant="foot" style={styles.audio} testID="meetings-mic-only">
        {MIC_ONLY_SENTENCE}
      </Text>
    );
  }

  return (
    <View style={styles.machineAudio}>
      <Switch
        value={on}
        onValueChange={toggle}
        label="Record the whole call"
        testID="meetings-machine-audio"
      />
      <Text variant="foot" style={styles.audio}>
        {capture.systemAudioNeedsPicker
          ? "Takes this machine's own audio as well as the microphone, so the far side of a call is in the note. Your browser asks which window or tab to take it from, every time."
          : "Takes this machine's own audio as well as the microphone, so the far side of a call is in the note."}
      </Text>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    audio: { marginTop: 12, maxWidth: 546 },
    machineAudio: { marginTop: 16, gap: 2, maxWidth: 546 },
  });
