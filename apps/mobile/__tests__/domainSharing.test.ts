/**
 * A WORKSPACE OPENED TO AN EMAIL DOMAIN — WHAT THE APP DECIDES (boards s3/s4).
 *
 * Who may join is the server's (`apps/convex/functions/workspaceDomains.ts`).
 * The app decides only when to ask: on opening a console link to a workspace
 * the server listed as joinable, before onboarding, so a first sign-in from
 * that link lands on it. And it owns the words.
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { domainJoinFor, slugInPath } from "../features/auth/domainJoin";
import { domainTitle, joinedLine, joinedNotice, offerLine } from "../features/console/settings/panels/organization";

const PW = { slug: "pw", name: "Public Worship", domain: "publicworship.org" };

describe("when to join", () => {
  test("reads the workspace out of a console address", () => {
    expect(slugInPath("/console/@pw")).toBe("pw");
    expect(slugInPath("/console/@PW/settings")).toBe("pw");
    expect(slugInPath("/console")).toBeNull();
    expect(slugInPath("/welcome")).toBeNull();
  });

  test("joins only a workspace the server listed, and never while the list is unknown", () => {
    expect(domainJoinFor("/console/@pw", [PW])).toEqual(PW);
    expect(domainJoinFor("/console/@other", [PW])).toBeNull();
    expect(domainJoinFor("/console/@pw", undefined)).toBeNull();
    expect(domainJoinFor("/console/@pw", [])).toBeNull();
  });

  test("the app layout joins after the phone check and before onboarding", () => {
    const source = readFileSync(join(__dirname, "../app/(app)/_layout.tsx"), "utf8");
    const gate = source.indexOf("domainJoinFor(");
    expect(gate).toBeGreaterThan(source.indexOf("blocksForPhone("));
    expect(gate).toBeLessThan(source.indexOf("needsOnboarding({"));
  });
});

describe("the words", () => {
  test("say who, how many, and why", () => {
    expect(domainTitle("publicworship.org")).toBe("Anyone with a @publicworship.org email");
    expect(joinedLine(0, true)).toBe("Nobody has joined this way yet");
    expect(joinedLine(1, true)).toBe("1 person joined this way");
    expect(joinedLine(7, false)).toBe("Off. 7 people joined this way.");
    expect(offerLine("ok", "dev2@supa.media")).toBe("You sign in with dev2@supa.media");
    expect(offerLine("personal", "x@gmail.com")).toBe("Personal email services can't be added");
    expect(joinedNotice("Public Worship", "publicworship.org")).toBe(
      "You joined Public Worship because your email ends in publicworship.org.",
    );
  });
});
