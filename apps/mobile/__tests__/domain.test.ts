import { describe, expect, test } from "@jest/globals";
import {
  cleanDomainInput,
  describeDomainFailure,
  domainPill,
  domainShapeProblem,
  domainSteps,
  problemCopy,
  transientNote,
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
