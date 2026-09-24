import { describe, expect, test } from "@jest/globals";
import {
  cleanDomainInput,
  describeDomainFailure,
  domainPill,
  domainShapeProblem,
  domainSteps,
  notYetNote,
  problemCopy,
  providerSentence,
  recordsSummary,
  transientNote,
  type DnsRecord,
  type DomainView,
} from "../features/console/domain/domain";

const base: DomainView = {
  id: "d",
  hostname: "docs.acme.com",
  apex: false,
  status: "pending",
  stage: "ownership",
  ownershipVerified: false,
  routingVerified: false,
  httpsReady: false,
  problem: null,
  homeSlug: null,
  checkedAt: null,
  records: [],
  oneClick: null,
};

describe("what somebody types", () => {
  test.each([
    ["https://Docs.Acme.com/intake", "docs.acme.com"],
    ["  docs.acme.com.  ", "docs.acme.com"],
  ])("%s is cleaned to %s", (raw, cleaned) => expect(cleanDomainInput(raw)).toBe(cleaned));

  test("our own domain and nonsense get a hint under the field", () => {
    expect(domainShapeProblem("staging.context.lc")).toContain("ours");
    expect(domainShapeProblem("acme")).toContain("doesn't look like a domain");
    expect(domainShapeProblem("docs.acme.com")).toBeNull();
    expect(domainShapeProblem("")).toBeNull();
  });

  test("a taken domain never names the workspace that holds it", () => {
    const failure = describeDomainFailure({ data: { code: "HOSTNAME_TAKEN", message: "x" } });
    expect(failure.field).toContain("already connected");
  });
});

describe("status", () => {
  test("no state is ever crit, and only live is ok", () => {
    const states: DomainView[] = [
      base,
      { ...base, stage: "https" },
      { ...base, problem: "TIMED_OUT" },
      { ...base, status: "active" },
      { ...base, status: "suspended" },
      { ...base, status: "removing" },
    ];
    const tones = states.map((state) => domainPill(state).tone);
    expect(tones).toEqual(["neutral", "neutral", "warn", "ok", "warn", "neutral"]);
  });

  test("problems that are ours to retry are a quiet note, not a warning", () => {
    const ours = { ...base, problem: "PROVIDER_UNAVAILABLE" };
    expect(domainPill(ours).label).toBe("Waiting for DNS");
    expect(problemCopy(ours)).toBeNull();
    expect(transientNote(ours)).toContain("try again");
  });

  test("steps stop at the first unmet check", () => {
    expect(domainSteps({ ...base, ownershipVerified: true }).map((step) => step.state)).toEqual([
      "done",
      "current",
      "todo",
    ]);
  });
});

describe("one-click setup", () => {
  const record = (type: string, done: boolean): DnsRecord => ({
    purpose: type === "CNAME" ? "routing" : "ownership",
    type,
    name: "n",
    host: "h",
    value: "v",
    done,
  });

  test("the folded records say which, then how many are in", () => {
    expect(recordsSummary([record("CNAME", false), record("TXT", false)])).toBe("CNAME and TXT");
    expect(recordsSummary([record("CNAME", false), record("TXT", true)])).toBe("1 of 2 found");
  });

  test("the provider is named, and the owner is told what happens there", () => {
    expect(providerSentence("GoDaddy")).toBe(
      "Your DNS is at GoDaddy. Sign in there and approve, and GoDaddy adds both records for you.",
    );
    expect(notYetNote("GoDaddy")).toContain("we'll keep checking");
  });
});
