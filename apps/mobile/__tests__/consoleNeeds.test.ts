/**
 * Home's "Needs you" as the page feeds it (`features/admin/console/pages/needs.web.ts`): the pure mapping from what each
 * read answered to `NeedsSources`, and the line-to-shell mapping `toNeed`. The React hooks are not mounted here.
 */
import { describe, expect, test } from "@jest/globals";
import { KNOWN_SECRETS } from "../features/admin/report";
import { needsSourcesOf, toNeed } from "../features/admin/console/pages/needs.web";
import { needsList, type NeedLine } from "../features/admin/console/pages/homeData";

type Raw = Parameters<typeof needsSourcesOf>[0];
type Light = NonNullable<Raw["light"]>;

/** The `consoleHome.needs` answer, with only the fields the mapping reads; the rest of its shape is not used here. */
const light = (over: Partial<Record<string, unknown>> = {}): Light =>
  ({
    waiting: 5,
    untold: 1,
    failedIndexes: 2,
    failedBackups: ["studio-ops"],
    openMail: [{ slug: "samw", ownerId: "user_samw" }],
    ...over,
  }) as unknown as Light;

/** The `admin.agentReport` answer's `current`, the part Needs you reads. */
const turns = (exhausted: number, failed: number): Raw["turns"] =>
  ({ current: { exhausted, failed } }) as unknown as Raw["turns"];

const allSecrets = () => KNOWN_SECRETS.map((k) => ({ name: k.name }));

describe("needsSourcesOf", () => {
  test("a fully set list of known credentials leaves none unset", () => {
    const s = needsSourcesOf({ secrets: allSecrets(), reports: [], turns: undefined, light: undefined });
    expect(s.secretsUnset).toBe(0);
  });

  test("a list missing one known credential counts exactly that one", () => {
    const missing = KNOWN_SECRETS[0]!.name;
    const secrets = allSecrets().filter((row) => row.name !== missing);
    const s = needsSourcesOf({ secrets, reports: undefined, turns: undefined, light: undefined });
    expect(s.secretsUnset).toBe(1);
  });

  test("an unknown name in the list does not stand in for a missing known one", () => {
    const secrets = allSecrets().slice(1).concat([{ name: "SOMETHING_ELSE" }]);
    const s = needsSourcesOf({ secrets, reports: undefined, turns: undefined, light: undefined });
    expect(s.secretsUnset).toBe(1);
  });

  test("no credentials set at all counts every known one", () => {
    const s = needsSourcesOf({ secrets: [], reports: undefined, turns: undefined, light: undefined });
    expect(s.secretsUnset).toBe(KNOWN_SECRETS.length);
  });

  test("a credentials read still loading is undefined, never zero", () => {
    const s = needsSourcesOf({ secrets: undefined, reports: undefined, turns: undefined, light: undefined });
    expect(s.secretsUnset).toBeUndefined();
  });

  test("open reports are their count, with no Tex split yet", () => {
    const s = needsSourcesOf({ secrets: undefined, reports: [{ id: 1 }, { id: 2 }], turns: undefined, light: undefined });
    expect(s.openReports).toEqual({ count: 2, viaTex: null });
  });

  test("no open reports is a count of zero, and a loading read is undefined", () => {
    expect(needsSourcesOf({ secrets: undefined, reports: [], turns: undefined, light: undefined }).openReports).toEqual({
      count: 0,
      viaTex: null,
    });
    expect(needsSourcesOf({ secrets: undefined, reports: undefined, turns: undefined, light: undefined }).openReports).toBeUndefined();
  });

  test("unfinished turns are the window's exhausted and failed counts", () => {
    const s = needsSourcesOf({ secrets: undefined, reports: undefined, turns: turns(9, 4), light: undefined });
    expect(s.unfinished).toEqual({ exhausted: 9, failed: 4 });
  });

  test("the light read passes its counts and lists through unchanged", () => {
    const l = light();
    const s = needsSourcesOf({ secrets: undefined, reports: undefined, turns: undefined, light: l });
    expect(s.waiting).toBe(5);
    expect(s.untold).toBe(1);
    expect(s.failedIndexes).toBe(2);
    expect(s.failedBackups).toEqual(["studio-ops"]);
    expect(s.mailOpen).toEqual([{ slug: "samw", ownerId: "user_samw" }]);
  });

  test("with every read undefined, every field is undefined", () => {
    const s = needsSourcesOf({ secrets: undefined, reports: undefined, turns: undefined, light: undefined });
    expect(s).toEqual({
      secretsUnset: undefined,
      openReports: undefined,
      unfinished: undefined,
      waiting: undefined,
      untold: undefined,
      failedIndexes: undefined,
      failedBackups: undefined,
      mailOpen: undefined,
    });
  });

  test("a loaded read and a loading read are kept apart: only the loading fields are undefined", () => {
    const s = needsSourcesOf({ secrets: allSecrets(), reports: undefined, turns: turns(0, 0), light: undefined });
    expect(s.secretsUnset).toBe(0);
    expect(s.openReports).toBeUndefined();
    expect(s.unfinished).toEqual({ exhausted: 0, failed: 0 });
    expect(s.waiting).toBeUndefined();
    expect(s.mailOpen).toBeUndefined();
  });

  test("a loaded light read with empty lists is zero and empty, not undefined", () => {
    const s = needsSourcesOf({
      secrets: undefined,
      reports: undefined,
      turns: undefined,
      light: light({ waiting: 0, untold: 0, failedIndexes: 0, failedBackups: [], openMail: [] }),
    });
    expect(s.waiting).toBe(0);
    expect(s.failedBackups).toEqual([]);
    expect(s.mailOpen).toEqual([]);
  });

  test("the mapped sources give the Needs you list the same lines the page shows", () => {
    const sources = needsSourcesOf({
      secrets: allSecrets().slice(1),
      reports: [{ id: 1 }],
      turns: turns(2, 1),
      light: light(),
    });
    expect(needsList(sources).map((n) => n.key)).toEqual([
      "credentials",
      "reports",
      "turns",
      "waiting",
      "untold",
      "indexes",
      "backup",
      "mail-samw",
    ]);
  });
});

describe("toNeed", () => {
  const line = (over: Partial<NeedLine> = {}): NeedLine => ({
    key: "k",
    tone: "warn",
    bold: "5 people",
    rest: " waiting to be let in",
    where: "People",
    target: { page: "people", f: { ps: "waiting" } },
    ...over,
  });

  test("the bold words are bolded, the rest is plain, and both are HTML-escaped", () => {
    const need = toNeed(line({ bold: "<img src=x>", rest: " & \"quoted\" 'single'" }));
    expect(need.html).toBe("<b>&lt;img src=x&gt;</b> &amp; &quot;quoted&quot; &#39;single&#39;");
  });

  test("an account name in the bold words cannot inject markup", () => {
    const need = toNeed(line({ bold: "@<script>alert(1)</script>", rest: " failed its backup encryption check" }));
    expect(need.html).not.toContain("<script>");
    expect(need.html.startsWith("<b>@&lt;script&gt;")).toBe(true);
  });

  test("tone and label carry over, and the target maps page to p", () => {
    const need = toNeed(line({ tone: "bad", where: "Storage", target: { page: "storage" } }));
    expect(need).toEqual({ tone: "bad", html: "<b>5 people</b> waiting to be let in", label: "Storage", to: { p: "storage" } });
  });

  test("subs, filters and a selected row map onto the shell's target", () => {
    const need = toNeed(line({ target: { page: "search", subs: ["indexes"], f: { a: "b" }, x: "row-1" } }));
    expect(need.to).toEqual({ p: "search", subs: ["indexes"], f: { a: "b" }, x: "row-1" });
  });

  test("x is left out when the target names no row", () => {
    const need = toNeed(line({ target: { page: "people", x: null } }));
    expect(need.to).toEqual({ p: "people" });
    expect(need.to).not.toHaveProperty("x");
  });

  test("x is set to the owner when a mail inbox names one", () => {
    const need = toNeed(line({ target: { page: "people", x: "user_samw" } }));
    expect(need.to).toEqual({ p: "people", x: "user_samw" });
  });

  test("a line with no subs, filters or x maps to the page alone", () => {
    const need = toNeed(line({ target: { page: "credentials" } }));
    expect(need.to).not.toHaveProperty("subs");
    expect(need.to).not.toHaveProperty("f");
    expect(need.to).toEqual({ p: "credentials" });
  });
});

describe("the sources end to end", () => {
  test("a missing credential reads as the bold count and the sentence the shell draws", () => {
    const sources = needsSourcesOf({
      secrets: allSecrets().slice(1),
      reports: undefined,
      turns: undefined,
      light: undefined,
    });
    const [need] = needsList(sources).map(toNeed);
    expect(need).toEqual({
      tone: "warn",
      html: "<b>1 credential</b> the code expects is not set",
      label: "Credentials",
      to: { p: "credentials" },
    });
  });
});
