import { describe, expect, test } from "@jest/globals";
import {
  cleanDomainInput,
  describeDomainFailure,
  domainPill,
  domainShapeProblem,
  domainSteps,
  notYetNote,
  pendingSentence,
  problemCopy,
  providerSentence,
  recordStatus,
  recordsSummary,
  USUAL_CONNECT_MS,
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
  checkingSince: 0,
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
    expect(domainPill(ours).label).toBe("Add records");
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

describe("a pending root domain says what is done and what is left", () => {
  const now = 10 * USUAL_CONNECT_MS;
  const rec = (purpose: DnsRecord["purpose"], type: string, host: string, done: boolean): DnsRecord => ({
    purpose,
    type,
    name: "n",
    host,
    value: "v",
    done,
  });
  const apex = (over: Partial<DomainView> = {}): DomainView => ({
    ...base,
    hostname: "seyi.co",
    apex: true,
    records: [
      rec("routing", "ALIAS", "@", false),
      rec("hostname", "TXT", "_cf-custom-hostname", false),
      rec("ownership", "TXT", "_context", false),
    ],
    ...over,
  });

  test("nothing found: count the records and ask for them", () => {
    const domain = apex({ checkingSince: now });
    expect(pendingSentence(domain, now)).toBe(
      "Add these three records where you manage seyi.co's DNS. We check on our own, so you can close this page.",
    );
    expect(domainPill(domain).label).toBe("Add records");
    expect(domain.records.map((record) => recordStatus(domain, record, now).label)).toEqual([
      "Not seen yet",
      "Not seen yet",
      "Not seen yet",
    ]);
  });

  test("ours found: nothing more to do if the rest are in, and they read Checking", () => {
    const domain = apex({
      stage: "routing",
      ownershipVerified: true,
      checkingSince: now - 60_000,
      records: [
        rec("routing", "ALIAS", "@", false),
        rec("hostname", "TXT", "_cf-custom-hostname", false),
        rec("ownership", "TXT", "_context", true),
      ],
    });
    expect(pendingSentence(domain, now)).toBe(
      "seyi.co is yours. If you've added the ALIAS and _cf-custom-hostname TXT records, there's nothing more to do. Connecting usually takes under 30 minutes, and you can close this page.",
    );
    expect(domainPill(domain).label).toBe("Connecting");
    expect(domain.records.map((record) => recordStatus(domain, record, now))).toEqual([
      { label: "Checking", tone: "neutral", dashed: true },
      { label: "Checking", tone: "neutral", dashed: true },
      { label: "Found", tone: "ok", dashed: false },
    ]);
  });

  test("past the usual wait, it asks the owner to look, and Checking becomes Not seen yet", () => {
    const domain = apex({
      stage: "routing",
      ownershipVerified: true,
      checkingSince: now - USUAL_CONNECT_MS,
      records: [rec("routing", "ALIAS", "@", false), rec("ownership", "TXT", "_context", true)],
    });
    expect(pendingSentence(domain, now)).toBe(
      "We haven't seen the ALIAS record reach us yet. Check it matches below at your DNS provider. Some providers take a few hours.",
    );
    expect(recordStatus(domain, domain.records[0]!, now).label).toBe("Not seen yet");
  });

  test("the folded summary counts three records as well as two", () => {
    expect(recordsSummary(apex().records)).toBe("3 records");
    expect(recordsSummary([rec("routing", "ALIAS", "@", true), rec("ownership", "TXT", "_context", true)])).toBe("Both found");
  });
});
