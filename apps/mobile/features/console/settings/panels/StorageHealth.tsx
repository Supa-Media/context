import { View, StyleSheet } from "react-native";
import { Check } from "../../../design/components/Field";
import type { PillTone } from "../../../design/components/Pill";
import { relativeTime } from "../../format";
import type { ConsoleStorage } from "../../types";

/**
 * The words at the top of Settings › Storage & search: is it working, what
 * kind of storage it is, and the checks that answer rests on.
 *
 * Every line is a claim about somebody's own bucket, so each one comes from
 * something that looked (#25): reachability from the binding's status, which
 * the verify probe sets by listing and writing; safe saving from the
 * connect-time capability probe; versioning from the provider's own setting.
 * Anything nobody measured is absent, never a placeholder and never a green row.
 */

/**
 * The one word at the top. "Healthy" only when both checks are green: a bucket
 * that works but cannot stop two saves colliding is working, with a limit, and
 * saying "Healthy" over an amber line is the disagreement #25 was about.
 */
export function storageVerdict(
  storage: Pick<ConsoleStorage, "connected" | "conditionalWrite">,
  failed: boolean,
): { title: string; pill: string; tone: PillTone } {
  if (failed) return { title: "Not working", pill: "Needs attention", tone: "crit" };
  if (!storage.connected) return { title: "Not checked yet", pill: "Unchecked", tone: "warn" };
  if (!storage.conditionalWrite) {
    return { title: "Working, with one limit", pill: "Working", tone: "warn" };
  }
  return { title: "Healthy", pill: "Healthy", tone: "ok" };
}

/**
 * Whose console somebody goes to for this storage, by name where we know it:
 * "Cloudflare" for R2, "Dropbox", and otherwise "your provider". An S3-
 * compatible endpoint could be anybody's, so it is never guessed at.
 */
export function storageCompany(storage: Pick<ConsoleStorage, "provider">): string | null {
  if (/dropbox/i.test(storage.provider)) return "Dropbox";
  if (/r2/i.test(storage.provider)) return "Cloudflare";
  return null;
}

/**
 * The line under the verdict: what kind of storage, how many files the last
 * check found, and when that was. Each part only when it was measured.
 */
export function storageLine(storage: ConsoleStorage, now: number): string {
  const company = storageCompany(storage);
  const kind =
    storage.managed === true
      ? "Storage Context runs for you"
      : company === "Dropbox"
        ? "Your own Dropbox"
        : company === null
          ? "Your own storage"
          : `Your own ${company} storage`;
  const files =
    storage.objectCount === undefined
      ? null
      : `${storage.objectCount} ${storage.objectCount === "1" ? "file" : "files"}`;
  const checked =
    // A zero is a row that was never verified, not a check in 1970.
    storage.lastVerifiedAt === undefined || storage.lastVerifiedAt <= 0
      ? null
      : `checked ${relativeTime(storage.lastVerifiedAt, now)}`;
  return [kind, files, checked].filter((part) => part !== null).join(" · ");
}

/** The lines the verdict rests on. */
export function StorageChecks({ storage, failed }: { storage: ConsoleStorage; failed: boolean }) {
  const where = storageCompany(storage) ?? "your provider";
  return (
    <View style={styles.checks}>
      {/*
        "At the last check" is the only tense this can honestly use: a key
        revoked at the provider a minute ago still reads `connected` until
        something asks again. A healthy one needs no line of its own; the
        verdict above already says it.
      */}
      {failed ? (
        <Check tone="warn">The last check couldn&apos;t open your files</Check>
      ) : storage.connected ? null : (
        <Check tone="warn">Not checked since it was connected. Press Check again.</Check>
      )}
      {storage.conditionalWrite ? (
        <Check tone="ok">Two people editing at once can&apos;t overwrite each other</Check>
      ) : (
        <Check tone="warn">
          This provider can&apos;t stop two saves at once from overwriting each other
        </Check>
      )}
      {storage.versioningOn === undefined ? null : storage.versioningOn ? (
        <Check tone="ok">Older versions are kept, so mistakes can be undone</Check>
      ) : (
        <Check tone="warn">
          {`Older versions aren't kept. Turn on versioning at ${where} to undo mistakes.`}
        </Check>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  checks: { gap: 8 },
});
