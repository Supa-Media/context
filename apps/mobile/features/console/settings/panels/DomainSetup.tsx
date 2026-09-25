import { useEffect, useState } from "react";
import { Linking, Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { Button, PressRow } from "../../../design/components/Button";
import { Grow, Row } from "../../../design/components/Card";
import { Icon } from "../../../design/components/Icon";
import { Notice } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { onReturnToApp } from "../../../app/returnToApp";
import { relativeTime } from "../../format";
import {
  awaySentence,
  needsAttention,
  notYetNote,
  pendingSentence,
  problemCopy,
  providerName,
  providerSentence,
  recordsSummary,
  transientNote,
  USUAL_CONNECT_MS,
  type DomainView,
} from "../../domain/domain";
import type { DomainActions } from "../../domain/useDomain";
import { DnsRecords, DomainSteps } from "./DomainRecords";

/**
 * A pending domain, as its owner sees it: the three checks, what to do next,
 * and when to look again.
 *
 * When the customer's DNS provider has our Domain Connect template, the card
 * leads with one button that sends them there to approve both records, and
 * the records to copy fold away beneath it. The records are only ever folded
 * on first sight: a link that arrives while somebody is reading them opens
 * the button above without collapsing what they were reading.
 */
export function DomainSetup({ domain, actions }: { domain: DomainView; actions: DomainActions }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const problem = problemCopy(domain);
  const note = transientNote(domain);
  const oneClick = domain.stage === "https" ? null : domain.oneClick;
  // Folded on first sight when there is a button above them, or once the
  // domain is proved to be theirs and the records are mostly a receipt.
  // Open again when something has been missing for longer than usual: then
  // the records are what the sentence asks the owner to look at.
  const [recordsOpen, setRecordsOpen] = useState(
    () =>
      (domain.oneClick === null && !domain.ownershipVerified) ||
      (domain.stage === "routing" && Date.now() - domain.checkingSince >= USUAL_CONNECT_MS),
  );
  // "Checking" turns into "Not seen yet" as time passes, without a query.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [away, setAway] = useState(false);
  const [back, setBack] = useState(false);
  // Full width is the thumb target on a phone; on a wide card it would be a bar.
  const wide = useWindowDimensions().width >= 600;

  // Coming back from the provider is the moment to look, not in ten minutes:
  // a tab regaining focus on the web, the app becoming active on a phone.
  useEffect(() => {
    if (!away) return;
    return onReturnToApp(
      () => {
        setBack(true);
        actions.checkNow().catch(() => undefined);
      },
      ["focus", "visibilitychange"],
    );
  }, [away, actions]);

  async function openProvider(url: string) {
    setAway(true);
    setBack(false);
    if (Platform.OS === "web") {
      const width = 600;
      const height = 720;
      const left = Math.max(0, Math.round((window.screen.width - width) / 2));
      const top = Math.max(0, Math.round((window.screen.height - height) / 2));
      // `noopener`: the provider's page gets no handle on this one. It also
      // makes `window.open` return null, so there is nothing to fall back on.
      window.open(url, "_blank", `popup,noopener,width=${width},height=${height},left=${left},top=${top}`);
      return;
    }
    await Linking.openURL(url).catch(() => undefined);
  }

  const sentence =
    oneClick === null ? pendingSentence(domain, now) : away ? awaySentence(oneClick.provider) : providerSentence(oneClick.provider);
  // The button labels speak the same name outside those sentences, so they
  // take it through the same container rather than off the row.
  const provider = oneClick === null ? "" : providerName(oneClick.provider);
  const showRecords = domain.stage !== "https";
  const foldable = oneClick !== null || domain.ownershipVerified;
  const folded = foldable && !recordsOpen && !needsAttention(domain);

  return (
    <>
      {problem !== null ? (
        <Notice tone="warn" style={styles.block}>
          <Text variant="rowTitle">{problem.title}</Text>
          <Text variant="rowSub" style={styles.sub}>
            {problem.body}
          </Text>
        </Notice>
      ) : null}
      <DomainSteps domain={domain} />
      <Text variant="rowSub" style={[styles.block, styles.measure]}>
        {sentence}
      </Text>
      {oneClick !== null ? (
        away ? (
          <Button
            variant="mini"
            label={`Open ${provider} again`}
            onPress={() => void openProvider(oneClick.url)}
            style={styles.action}
            testID="domain-one-click-again"
          />
        ) : (
          <Button
            variant="accent"
            label={`Set up with ${provider}`}
            onPress={() => void openProvider(oneClick.url)}
            style={wide ? styles.actionHug : styles.action}
            testID="domain-one-click"
          />
        )
      ) : null}
      {oneClick !== null && away && back ? (
        <Text variant="foot" style={styles.block}>
          {notYetNote(oneClick.provider)}
        </Text>
      ) : null}
      {showRecords && foldable ? (
        <Row divided style={styles.disclosure}>
          <PressRow
            accessibilityLabel={folded ? "Show the DNS records" : "Hide the DNS records"}
            onPress={() => setRecordsOpen((open) => !open)}
            radius={radii.md}
            testID="domain-records-toggle"
          >
            <View style={styles.toggle}>
              <Icon name={folded ? "chevronRight" : "chevronDown"} size={13} color={colors.text2} />
              <Grow>
                <Text variant="rowTitle">{oneClick !== null ? "Add the records yourself" : "Your DNS records"}</Text>
                <Text variant="rowSub" style={styles.sub}>
                  {recordsSummary(domain.records)}
                </Text>
              </Grow>
            </View>
          </PressRow>
        </Row>
      ) : null}
      {showRecords && !folded ? <DnsRecords domain={domain} now={now} /> : null}
      {note !== null ? (
        <Text variant="foot" style={styles.block}>
          {note}
        </Text>
      ) : null}
      <CheckLine domain={domain} actions={actions} />
    </>
  );
}

function CheckLine({ domain, actions }: { domain: DomainView; actions: DomainActions }) {
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  // Re-render once in a while so "Checked just now" ages without a query.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  // A finished check lands as a new `checkedAt`; that is when the press is over.
  useEffect(() => setBusy(false), [domain.checkedAt]);

  return (
    <Row style={styles.checkLine}>
      <Grow>
        <Text variant="meta">
          {domain.checkedAt === null ? "Checking…" : `Checked ${relativeTime(domain.checkedAt, now)}`}
        </Text>
      </Grow>
      <Button
        variant="mini"
        label={busy ? "Checking…" : "Check again"}
        disabled={busy}
        testID="domain-check"
        onPress={() => {
          setBusy(true);
          actions.checkNow().catch(() => setBusy(false));
        }}
      />
    </Row>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    sub: { marginTop: 2 },
    block: { marginTop: 13 },
    measure: { maxWidth: 546 },
    action: { marginTop: 13, alignSelf: "stretch", justifyContent: "center" },
    actionHug: { marginTop: 13, alignSelf: "flex-start" },
    disclosure: { marginTop: 13 },
    toggle: { flexDirection: "row", alignItems: "center", gap: 10 },
    checkLine: { marginTop: 13 },
  });
