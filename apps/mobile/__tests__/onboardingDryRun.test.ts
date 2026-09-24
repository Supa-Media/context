import { describe, expect, test } from "@jest/globals";
import { DRY_RUN_LEDE, dryRunReport } from "../features/onboarding/dryRun";

const base = {
  provider: "r2",
  bucket: "notes-live",
  region: "auto",
  capabilities: { conditionalWrite: true },
  scaffoldReason: "empty",
  noteCount: 0,
};

const value = (report: ReturnType<typeof dryRunReport>, key: string) =>
  report.findings.find((finding) => finding.key === key);

describe("the dry-run report", () => {
  test("never claims nothing was written: the probe wrote and removed one object", () => {
    expect(DRY_RUN_LEDE).toMatch(/temporary test object/);
    expect(DRY_RUN_LEDE).toMatch(/removed/);
    expect(DRY_RUN_LEDE).not.toMatch(/^We listed your bucket, read-only/);
  });

  test("an empty R2 bucket that honours conditional writes looks ready", () => {
    const report = dryRunReport(base);
    expect(report.looksReady).toBe(true);
    expect(report.bucket).toBe("notes-live");
    expect(value(report, "provider")?.value).toBe("Cloudflare R2");
    expect(value(report, "notes")?.tone).toBe("ok");
  });

  test("a provider that ignores conditional writes is said so, and is worth a second look", () => {
    const report = dryRunReport({ ...base, provider: "b2", capabilities: { conditionalWrite: false } });
    expect(value(report, "conditional")).toMatchObject({ tone: "warn" });
    expect(value(report, "conditional")?.value).toMatch(/last save wins/);
    expect(report.looksReady).toBe(false);
  });

  test("a bucket that already holds a context is used as it is", () => {
    const report = dryRunReport({ ...base, scaffoldReason: "existing-context", noteCount: 312 });
    expect(value(report, "context")?.value).toMatch(/use it as it is/);
    expect(value(report, "notes")?.value).toMatch(/^312 — they stay/);
    expect(report.looksReady).toBe(true);
  });

  test("a count that stopped short says so", () => {
    const report = dryRunReport({ ...base, noteCount: 39_000, noteCountTruncated: true });
    expect(value(report, "notes")?.value).toMatch(/^39,000\+/);
  });

  test("what the probe never reached is not reported as fine", () => {
    const report = dryRunReport({ ...base, scaffoldReason: undefined, noteCount: undefined });
    expect(value(report, "context")?.tone).toBe("warn");
    expect(value(report, "notes")?.value).toBe("Not counted yet");
    expect(report.looksReady).toBe(false);
  });

  test("a root prefix is part of the address", () => {
    expect(dryRunReport({ ...base, rootPrefix: "context/" }).bucket).toBe("notes-live / context");
  });
});
