import { describe, expect, test } from "@jest/globals";
import {
  addressChoices,
  companySteps,
  hintCopy,
  hintRecord,
  lookupLines,
  replacesSite,
  type DomainLookup,
} from "../features/console/domain/domainHelp";

type Found = Extract<DomainLookup, { ok: true }>;

function lookup(over: Partial<Found> = {}): Found {
  return {
    ok: true,
    hostname: "acme.com",
    zone: "acme.com",
    apex: true,
    dnsHost: { key: "godaddy", name: "GoDaddy" },
    rootCanPoint: false,
    current: { kind: "parked" },
    wwwCurrent: { kind: "parked" },
    ...over,
  };
}

describe("addressChoices", () => {
  test("a root at a company that can't point roots recommends www, and never offers the root", () => {
    const choices = addressChoices(lookup());
    expect(choices.map((c) => c.value)).toEqual(["www.acme.com", ""]);
    expect(choices[0]!.recommended).toBe(true);
    expect(choices[0]!.detail).toContain("GoDaddy");
  });

  test("a root at a company that can point roots recommends the root", () => {
    const choices = addressChoices(lookup({ dnsHost: { key: "cloudflare", name: "Cloudflare" }, rootCanPoint: true }));
    expect(choices.map((c) => c.value)).toEqual(["acme.com", "www.acme.com", ""]);
    expect(choices.filter((c) => c.recommended).map((c) => c.value)).toEqual(["acme.com"]);
  });

  test("an unknown company still offers the root", () => {
    expect(addressChoices(lookup({ dnsHost: null, rootCanPoint: null }))[0]!.value).toBe("acme.com");
  });

  test("a subdomain is offered as typed", () => {
    const choices = addressChoices(lookup({ hostname: "blog.acme.com", apex: false }));
    expect(choices).toEqual([{ value: "blog.acme.com", label: "blog.acme.com", detail: "", recommended: true }]);
  });
});

describe("replacesSite and lookupLines", () => {
  test("names the website that www would replace", () => {
    const found = lookup({ wwwCurrent: { kind: "site", site: "Squarespace" } });
    expect(replacesSite(found, "www.acme.com")).toBe(
      "A Squarespace website is on www.acme.com now. Connecting replaces that website.",
    );
    expect(replacesSite(found, "acme.com")).toBeNull();
  });

  test("a parked page or nothing is not a loss", () => {
    expect(replacesSite(lookup(), "www.acme.com")).toBeNull();
    expect(replacesSite(lookup({ current: { kind: "empty" } }), "acme.com")).toBeNull();
  });

  test("a part typed below is never judged against the root's answer", () => {
    expect(replacesSite(lookup({ current: { kind: "elsewhere", value: "1.2.3.4" } }), "shop.acme.com")).toBeNull();
  });

  test("always promises mail keeps working and names the company", () => {
    const lines = lookupLines(lookup(), "www.acme.com");
    expect(lines[0]).toBe("Its settings are at GoDaddy.");
    expect(lines).toContain("Your email keeps working. We never change mail settings.");
  });
});

describe("hints", () => {
  const domain = {
    hostname: "blog.danielle.studio",
    zone: "danielle.studio",
    dnsHost: { key: "cloudflare", name: "Cloudflare" },
    records: [
      { purpose: "routing" as const, type: "CNAME", name: "blog.danielle.studio", host: "blog", value: "x", done: false },
      {
        purpose: "ownership" as const,
        type: "TXT",
        name: "_context.blog.danielle.studio",
        host: "_context.blog",
        value: "y",
        done: false,
      },
    ],
  };

  test("each hint sits under the record it is about", () => {
    expect(hintRecord({ code: "DOUBLED_OWNERSHIP", name: "n" })).toBe("ownership");
    expect(hintRecord({ code: "PROXIED" })).toBe("routing");
    expect(hintRecord({ code: "CAA_BLOCKS", name: "n" })).toBeNull();
  });

  test("a doubled Name says what the box should hold", () => {
    const copy = hintCopy(domain, { code: "DOUBLED_OWNERSHIP", name: "_context.blog.danielle.studio.danielle.studio" });
    expect(copy.body).toContain("Cloudflare adds the domain itself");
    expect(copy.body).toContain("should say only _context.blog.");
  });

  test("the company's own screens come from the shared table", () => {
    expect(companySteps(domain).open).toContain("Cloudflare");
    expect(companySteps({ ...domain, dnsHost: null }).open).not.toContain("Cloudflare");
  });
});
