/**
 * The dry-run report: what we found in a bucket somebody brought, from the
 * binding the connect probe just verified.
 *
 * ## What it may claim
 *
 * Only what the probe observed. Connecting lists the bucket, writes one
 * temporary object under `.context/probes/` and removes it again, and — with
 * no layout chosen yet — looks for an existing context without touching it
 * (`verifyStorageBinding`, "Look, do not touch"). So the report says a test
 * object was written and removed, never "nothing was written"; and it reports
 * conflict safety as the probe *saw* it, which is the whole point of probing
 * rather than trusting the provider's name (B2 and Wasabi accept the header
 * and ignore it).
 */

import type { DryRunFinding } from "./redesign/DryRunStep";

/** The fields of `storage.getStorageBinding` the report reads. */
export interface DryRunBinding {
  provider: string;
  bucket?: string;
  region?: string;
  rootPrefix?: string;
  capabilities?: { conditionalWrite?: boolean };
  scaffoldReason?: string;
  noteCount?: number;
  noteCountTruncated?: boolean;
}

export interface DryRunReport {
  bucket: string;
  region: string;
  findings: DryRunFinding[];
  /** Every finding is one a person can continue past without a second look. */
  looksReady: boolean;
}

export const DRY_RUN_LEDE =
  "We listed your bucket and checked we can write to it: one temporary test object under " +
  ".context/probes/, written and removed again. Nothing else has been written, moved or " +
  "renamed. Here is what we saw.";

const PROVIDERS: Record<string, string> = {
  r2: "Cloudflare R2",
  s3: "Amazon S3",
  b2: "Backblaze B2",
  "s3-compatible": "S3-compatible",
  "r2-binding": "Cloudflare R2",
  dropbox: "Dropbox",
};

export function providerLabel(provider: string): string {
  return PROVIDERS[provider] ?? provider;
}

function notesFinding(binding: DryRunBinding): DryRunFinding {
  const count = binding.noteCount;
  if (typeof count !== "number") {
    return { key: "notes", label: "Notes in it", value: "Not counted yet", tone: "neutral" };
  }
  if (count === 0) {
    return { key: "notes", label: "Notes in it", value: "None — it holds no Markdown yet", tone: "ok" };
  }
  const figure = `${count.toLocaleString("en-US")}${binding.noteCountTruncated === true ? "+" : ""}`;
  return {
    key: "notes",
    label: "Notes in it",
    value: `${figure} — they stay exactly where they are`,
    tone: "neutral",
  };
}

function contextFinding(reason: string | undefined): DryRunFinding {
  switch (reason) {
    case "existing-context":
      return {
        key: "context",
        label: "Already a context?",
        value: "Yes — we will use it as it is, and ask no layout question",
        tone: "ok",
      };
    case "empty":
      return {
        key: "context",
        label: "Already a context?",
        value: "No — you can choose a starting layout next, or skip it",
        tone: "ok",
      };
    default:
      return {
        key: "context",
        label: "Already a context?",
        value: "Not checked — the probe did not get that far",
        tone: "warn",
      };
  }
}

function conflictFinding(conditionalWrite: boolean): DryRunFinding {
  return conditionalWrite
    ? {
      key: "conditional",
      label: "Conflict-safe saves",
      value: "Supported — two edits cannot silently overwrite each other",
      tone: "ok",
    }
    : {
      key: "conditional",
      label: "Conflict-safe saves",
      value: "Not honoured by this provider — the last save wins",
      tone: "warn",
    };
}

export function dryRunReport(binding: DryRunBinding): DryRunReport {
  const conditionalWrite = binding.capabilities?.conditionalWrite === true;
  const context = contextFinding(binding.scaffoldReason);
  const findings: DryRunFinding[] = [
    { key: "provider", label: "Storage", value: providerLabel(binding.provider), tone: "neutral" },
    notesFinding(binding),
    context,
    conflictFinding(conditionalWrite),
    {
      key: "write-check",
      label: "Write check",
      value: "Passed — one test object written and removed",
      tone: "ok",
    },
  ];
  const prefix = binding.rootPrefix ? ` / ${binding.rootPrefix.replace(/\/+$/, "")}` : "";
  return {
    bucket: `${binding.bucket ?? "—"}${prefix}`,
    region: binding.region || "auto",
    findings,
    looksReady: conditionalWrite && context.tone === "ok",
  };
}
