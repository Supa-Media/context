import { StyleSheet, View } from "react-native";
import { CopyField } from "../../../design/components/CopyField";
import { Dot } from "../../../design/components/Dot";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  apexNote,
  domainSteps,
  recordPurpose,
  recordStatus,
  stepsLabel,
  type DnsRecord,
  type DomainView,
} from "../../domain/domain";

/**
 * Three dots and three words — Verified · Connected · HTTPS — instead of a
 * spinner. One accessible label for the row, so a screen reader hears where
 * the domain is rather than three fragments.
 */
export function DomainSteps({ domain }: { domain: DomainView }) {
  const styles = useThemedStyles(makeStyles);
  const steps = domainSteps(domain);
  return (
    <View style={styles.steps} accessible accessibilityLabel={stepsLabel(steps)} testID="domain-steps">
      {steps.map((step) => (
        <View key={step.label} style={styles.step}>
          <Dot tone={step.state === "done" ? "ok" : "neutral"} size={6} />
          <Text
            variant="check"
            style={step.state === "done" ? styles.done : step.state === "current" ? styles.current : styles.todo}
          >
            {step.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The records to add, stacked so they fit a phone: what each is for and
 * whether we have found it, then its name and value with one-tap copy. The
 * name is shown as DNS providers' forms want it (`docs`, `@`), with the full
 * name underneath for the ones that want that instead.
 */
export function DnsRecords({ domain, now }: { domain: DomainView; now: number }) {
  return (
    <View>
      {domain.records.map((record) => (
        <Record key={record.purpose} domain={domain} record={record} now={now} />
      ))}
    </View>
  );
}

function Record({ domain, record, now }: { domain: DomainView; record: DnsRecord; now: number }) {
  const styles = useThemedStyles(makeStyles);
  const status = recordStatus(domain, record, now);
  return (
    <View style={styles.record} testID={`domain-record-${record.purpose}`}>
      <View style={styles.recordHead}>
        <Text variant="rowTitle" style={styles.recordTitle}>
          {`${record.type} record`}
        </Text>
        <Pill
          tone={status.tone}
          dashed={status.dashed}
          leading={status.tone === "ok" ? <Dot tone="ok" /> : undefined}
          testID={`domain-record-${record.purpose}-status`}
        >
          {status.label}
        </Pill>
      </View>
      <Text variant="rowSub">{recordPurpose(record)}</Text>
      <Text variant="eyebrow" style={styles.label}>
        Name
      </Text>
      <CopyField value={record.host} label={`Copy the record name, ${record.host}`} />
      {record.host !== record.name ? (
        <Text variant="foot" style={styles.fullName}>
          {`Some providers want the full name: ${record.name}`}
        </Text>
      ) : null}
      <Text variant="eyebrow" style={styles.label}>
        Value
      </Text>
      <CopyField value={record.value} label="Copy the record value" />
      {domain.apex && record.purpose === "routing" && !record.done ? (
        <Text variant="foot" style={styles.fullName}>
          {apexNote(domain.hostname)}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    steps: { flexDirection: "row", flexWrap: "wrap", gap: 13, marginTop: 13 },
    step: { flexDirection: "row", alignItems: "center", gap: 6 },
    done: { color: colors.text2 },
    current: { color: colors.text },
    todo: { color: colors.muted },
    record: {
      marginTop: 13,
      paddingTop: 13,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    recordHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    recordTitle: { flexShrink: 1 },
    label: { marginTop: 10, marginBottom: 4 },
    fullName: { marginTop: 4 },
  });
