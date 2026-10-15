import { useState } from "react";
import { Linking, Pressable, type StyleProp, type TextStyle } from "react-native";
import { useConvexAuth } from "convex/react";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { ReportDialog } from "./ReportDialog";
import { reportMailto, type ReportPerson, type ReportTarget } from "./model";

/**
 * "Report or block" beside something another person sent you: a @shared row,
 * an open shared note, an invitation. Opens `ReportDialog`.
 */
export function ReportLink({
  target,
  person,
  label = person === null ? "Report" : "Report or block",
  testID,
}: {
  target: ReportTarget;
  person: ReportPerson | null;
  label?: string;
  testID?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TextLink label={label} onPress={() => setOpen(true)} testID={testID} />
      {open ? <ReportDialog target={target} person={person} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The quiet "Report" under a public page — a share link or a website.
 *
 * Signed in, it is the in-app report (`public_page`). Signed out — every
 * visitor on a customer's own domain, where no session can exist — it is an
 * email to support with the page's address in the subject: nothing to submit
 * anonymously, so nothing an anonymous visitor could probe or flood.
 */
export function ReportPageLink({
  target,
  address,
  style,
}: {
  target: Extract<ReportTarget, { kind: "public_page" }>;
  /** The page's address as the visitor has it, for the email's subject. */
  address: () => string;
  style?: StyleProp<TextStyle>;
}) {
  const auth = useConvexAuth();
  const [open, setOpen] = useState(false);
  const press = () => {
    if (auth.isAuthenticated) setOpen(true);
    else void Linking.openURL(reportMailto(address())).catch(() => undefined);
  };
  return (
    <>
      <Pressable accessibilityRole="link" accessibilityLabel="Report this page" onPress={press} testID="report-page">
        <Text variant="body" style={style}>
          Report
        </Text>
      </Pressable>
      {open ? <ReportDialog target={target} person={null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Where the visitor is, for the email: the page's own URL on the web. */
export function currentAddress(fallback: string): string {
  const href = (globalThis as { location?: { href?: string } }).location?.href;
  return typeof href === "string" && href !== "" ? href : fallback;
}
