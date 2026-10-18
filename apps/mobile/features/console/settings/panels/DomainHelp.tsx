import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Grow, Row } from "../../../design/components/Card";
import { FormError, TextField } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { TextLink } from "../../../design/components/TextLink";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { describeDomainFailure, registrableDomain, type DnsRecord, type DomainView } from "../../domain/domain";
import { companySteps, hintCopy, hintRecord } from "../../domain/domainHelp";
import type { DomainActions } from "../../domain/useDomain";

/**
 * The help around a pending domain's records: the company's own screens, the
 * mistakes public DNS shows, the root's forwarding when `www.` was connected
 * on its own, and emailing the steps to whoever runs the domain.
 *
 * Findings are words on the step they belong to, in the warning text colour
 * and never in a box (Dev2, 2026-10-11).
 */

/** "In GoDaddy, open My Products, find acme.com and choose DNS." */
export function CompanyOpen({ domain }: { domain: DomainView }) {
  const styles = useThemedStyles(makeStyles);
  const steps = companySteps(domain);
  return (
    <Text variant="rowSub" style={[styles.block, styles.measure]} testID="domain-company-open">
      {`${steps.open} ${steps.add.replace(/:$/, ".")}`}
    </Text>
  );
}

/** Under one record: what public DNS says is wrong with it. */
export function RecordHints({ domain, purpose }: { domain: DomainView; purpose: DnsRecord["purpose"] }) {
  return <Hints domain={domain} hints={domain.hints.filter((hint) => hintRecord(hint) === purpose)} />;
}

/** Above the records: what is wrong with the domain as a whole. */
export function DomainHints({ domain }: { domain: DomainView }) {
  return <Hints domain={domain} hints={domain.hints.filter((hint) => hintRecord(hint) === null)} />;
}

function Hints({ domain, hints }: { domain: DomainView; hints: DomainView["hints"] }) {
  const styles = useThemedStyles(makeStyles);
  if (hints.length === 0) return null;
  return (
    <View testID="domain-hints">
      {hints.map((hint) => {
        const copy = hintCopy(domain, hint);
        return (
          <Text key={hint.code} variant="rowSub" style={[styles.hint, styles.measure]} role="alert">
            <Text variant="rowSub" style={styles.hintTitle}>
              {copy.title}
            </Text>
            {` ${copy.body}`}
          </Text>
        );
      })}
    </View>
  );
}

/**
 * `www.acme.com` connected on its own: `acme.com` should send people to it.
 * Done at the DNS company, so the step names their screen; we look for the
 * redirect beside every check.
 */
export function ForwardingStep({ domain }: { domain: DomainView }) {
  const styles = useThemedStyles(makeStyles);
  const forwarding = domain.forwarding;
  if (forwarding === null || forwarding.forwards === true) return null;
  return (
    <View style={styles.record} testID="domain-forwarding">
      <Row>
        <Grow>
          <Text variant="rowTitle">{`Send ${forwarding.root} to www`}</Text>
        </Grow>
        <Pill tone="neutral" dashed>
          {domain.status === "active" ? "Not seen yet" : "Checking"}
        </Pill>
      </Row>
      <Text variant="rowSub" style={[styles.sub, styles.measure]}>
        {companySteps(domain).forwarding}
      </Text>
    </View>
  );
}

/**
 * "Someone else looks after this domain?" — the same steps, emailed. Plain
 * text with no link into Context, so it cannot pass for a sign-in request.
 */
export function EmailSteps({ domain, actions }: { domain: DomainView; actions: DomainActions }) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const zone = domain.zone ?? registrableDomain(domain.hostname);

  async function send() {
    if (busy || to.trim() === "") return;
    setBusy(true);
    setFieldError(undefined);
    setFormError(undefined);
    try {
      await actions.emailSteps(to.trim(), note.trim() === "" ? null : note.trim());
      setOpen(false);
      setTo("");
      setNote("");
    } catch (error) {
      const failure = describeDomainFailure(error);
      setFieldError(failure.field);
      setFormError(failure.form);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Row divided style={styles.block} testID="domain-email-steps">
        <Grow>
          <Text variant="rowSub">
            {domain.stepsSent !== null
              ? `Sent to ${domain.stepsSent.to}. We'll email you both when it's live.`
              : `Someone else looks after ${zone}?`}
          </Text>
        </Grow>
        <TextLink
          label={domain.stepsSent !== null ? "Send again" : "Email them these steps"}
          onPress={() => setOpen(true)}
          testID="domain-email-steps-open"
        />
      </Row>
    );
  }

  return (
    <View style={[styles.record, styles.measure]} testID="domain-email-steps-form">
      <Text variant="rowTitle">Email the steps</Text>
      <Text variant="rowSub" style={styles.sub}>
        They get the steps and the values to paste. Nothing from your notes, and no link into Context.
      </Text>
      <TextField
        label="Their email"
        placeholder="name@example.com"
        value={to}
        onChangeText={(next) => {
          setTo(next);
          setFieldError(undefined);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        inputMode="email"
        error={fieldError}
        containerStyle={styles.field}
        testID="domain-email-steps-to"
      />
      <TextField
        label="A note from you"
        optional
        placeholder="Could you add these for my new site?"
        value={note}
        onChangeText={setNote}
        maxLength={300}
        multiline
        containerStyle={styles.field}
        testID="domain-email-steps-note"
      />
      {formError !== undefined ? <FormError headline={formError} style={styles.field} /> : null}
      <Row style={styles.field}>
        <Button
          label={busy ? "Sending…" : "Send"}
          variant="accent"
          disabled={busy || to.trim() === ""}
          onPress={() => void send()}
          testID="domain-email-steps-send"
        />
        <TextLink label="Cancel" onPress={() => setOpen(false)} style={styles.cancel} />
      </Row>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    block: { marginTop: 13 },
    sub: { marginTop: 2 },
    measure: { maxWidth: 546 },
    hint: { marginTop: 8, color: colors.warnText },
    hintTitle: { color: colors.warnText, fontWeight: "600" },
    record: {
      marginTop: 13,
      paddingTop: 13,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    field: { marginTop: 12 },
    cancel: { marginLeft: 16, alignSelf: "center" },
  });
