import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useColors } from "../design/theme";
import { TranscriptionConsent } from "../meetings/components/TranscriptionConsent";
import { CONSENT_NOT_SAVED } from "../meetings/useTranscriptionConsent";
import {
  CloudTranscriptionView,
  type CloudTranscriptionState,
} from "../console/settings/panels/CloudTranscriptionSettings";

/**
 * Cloud transcription consent, for screenshots and for App Review's steps
 * (`docs/decisions/meetings/transcription-consent.md`).
 *
 * `/e2e-fixture?screen=transcription-consent&at=dialog|failed|on|off|outdated`:
 * `dialog` is the question in front of a New meeting, `failed` the same after
 * a yes that did not save, and the other three the Settings › Meetings row.
 * Allow on the row opens the same dialog. Nothing is saved and nothing records.
 */
export function TranscriptionConsentFixture({ view }: { view?: string }) {
  const colors = useColors();
  const initial: CloudTranscriptionState = view === "on" || view === "outdated" ? view : "off";
  const [state, setState] = useState<CloudTranscriptionState>(initial);
  const [asking, setAsking] = useState(view === "dialog" || view === "failed");

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }} testID="transcription-consent-fixture">
      <ScrollView contentContainerStyle={{ padding: 16, maxWidth: 640 }}>
        <CloudTranscriptionView
          state={state}
          busy={false}
          problem={false}
          onTurnOff={() => setState("off")}
          onAllow={() => setAsking(true)}
        />
      </ScrollView>
      {asking ? (
        <TranscriptionConsent
          busy={false}
          failed={view === "failed" ? CONSENT_NOT_SAVED : null}
          onAllow={() => {
            setState("on");
            setAsking(false);
          }}
          onDecline={() => setAsking(false)}
        />
      ) : null}
    </View>
  );
}
