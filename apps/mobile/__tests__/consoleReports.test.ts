import { beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
/**
 * The Reports page (`features/admin/console/pages/Reports.web.tsx`): the artifact's `P.reports` and
 * its side panel, on the two sources merged. The model and the markup are pure; these tests keep
 * the artifact's labels, classes and rules, and that a title is never drawn as markup.
 */
import { esc } from "../features/admin/console/kit";
import { setRoutes } from "../features/admin/console/state";
import {
  ago,
  filterReports,
  mergeReports,
  parseTexNote,
  texIds,
  type ContentRow,
  type Notes,
  type Report,
  type TexBug,
} from "../features/admin/console/pages/reports/model";
import { renderProps, renderReports, renderTools } from "../features/admin/console/pages/reports/render";
import { reportsPage, type ReportsData } from "../features/admin/console/pages/Reports.web";
import { jest } from "@jest/globals";

beforeAll(() => {
  setRoutes({
    pages: ["home", "reports"],
    windowed: new Set(),
    filters: { src: ["all", ["reports"]], st: ["open", ["reports"]] },
  });
});

const NOW = new Date(2026, 10, 14, 12, 0).getTime();
const hours = (n: number) => NOW - n * 3_600_000;
const days = (n: number) => NOW - n * 86_400_000;

const content: ContentRow[] = [
  {
    id: "c1",
    createdAt: hours(3),
    kind: "share",
    reason: "Spam links in a shared note",
    details: "Twelve links to a crypto site were pasted into a note shared with me.",
    reporter: "@amara",
    about: "@leo",
    workspace: "@studio-ops",
    handledAt: null,
    handledBy: null,
  },
  {
    id: "c2",
    createdAt: days(2),
    kind: "invitation",
    reason: "Invitation from someone I don't know",
    details: null,
    reporter: "leo@example.net",
    about: null,
    workspace: "@fieldwork",
    handledAt: new Date(2026, 10, 12, 9).getTime(),
    handledBy: "@staff1",
  },
];

const bug = (path: string, filed: number, status: string, title: string | null = null): TexBug => ({
  path,
  filed,
  status,
  reporter: "user",
  textsShared: true,
  title,
});

const tex: TexBug[] = [
  bug("areas/tex-bugs/user/2026-11-14 0900 table booking.md", hours(5), "open", "Tex said it booked the table but didn't"),
  bug("areas/tex-bugs/team/2026-11-13 1200 flyer twice.md", days(1), "open", "Replied twice to one picture"),
  bug("areas/tex-bugs/user/2026-11-10 0800 dentist.md", days(4), "retired", "Forgot my dentist moved"),
];

const notes: Notes = {
  "areas/tex-bugs/user/2026-11-14 0900 table booking.md": {
    state: "ready",
    message: "you said 7pm at Lupa was booked, there is no booking",
    texts: [
      ["them", "did you book lupa for 7?"],
      ["tex", "Booked! Lupa, 7pm, party of 2."],
      ["them", "there is no booking in my email"],
    ],
  },
};

const merged = () => mergeReports({ content, tex, notes, now: NOW });

describe("merging the two sources", () => {
  it("lists both sources newest first, each in the artifact's shape", () => {
    const reports = merged();
    expect(reports.map((r) => r.title)).toEqual([
      "Spam links in a shared note",
      "Tex said it booked the table but didn't",
      "Replied twice to one picture",
      "Invitation from someone I don't know",
      "Forgot my dentist moved",
    ]);
    const first = reports[0]!;
    expect(first).toMatchObject({ src: "content", kind: "A note shared with them", when: "3h ago", reporter: "@amara", about: "@studio-ops · @leo", open: true });
    expect(first.handled).toBeUndefined();
  });

  it("marks a content report handled with who and when, and a Tex report by its status", () => {
    const reports = merged();
    const invite = reports.find((r) => r.id === "c2")!;
    expect(invite).toMatchObject({ open: false, handled: "Handled by @staff1 · 2d ago", kind: "An invitation" });
    const dentist = reports.find((r) => r.title === "Forgot my dentist moved")!;
    expect(dentist).toMatchObject({ src: "tex", open: false, handled: "Retired", reporter: "someone using Tex", when: "4d ago" });
  });

  it("gives a Tex report its texts once read, and says it is loading until then", () => {
    const reports = merged();
    const table = reports.find((r) => r.title.startsWith("Tex said"))!;
    expect(table.details).toBe("you said 7pm at Lupa was booked, there is no booking");
    expect(table.thread).toEqual([
      ["them", "did you book lupa for 7?"],
      ["tex", "Booked! Lupa, 7pm, party of 2."],
      ["them", "there is no booking in my email"],
    ]);
    const flyer = reports.find((r) => r.title.startsWith("Replied twice"))!;
    expect(flyer.details).toBe("Loading the texts");
    expect(flyer.thread).toBeUndefined();
  });

  it("gives every Tex report an address-safe id, unique even when two hashes meet", () => {
    const ids = texIds(tex.map((b) => b.path));
    expect([...ids.values()].every((id) => /^t-[0-9a-f]{8}(-\d+)?$/.test(id))).toBe(true);
    expect(new Set(ids.values()).size).toBe(tex.length);
    const twin = texIds(["a.md", "a.md"]);
    expect(twin.size).toBe(1);
  });

  it("words relative times the artifact's way", () => {
    expect(ago(NOW - 30_000, NOW)).toBe("just now");
    expect(ago(hours(3), NOW)).toBe("3h ago");
    expect(ago(days(2), NOW)).toBe("2d ago");
    expect(ago(days(9), NOW)).toBe("Nov 5");
  });
});

describe("filters and counts", () => {
  it("counts open and all in the State control, whatever the source filter", () => {
    const reports = merged();
    const tools = renderTools(reports, { src: "tex", st: "open" });
    expect(tools).toContain('Open <span class="n">3</span>');
    expect(tools).toContain('All <span class="n">5</span>');
    expect(tools).toContain('aria-label="State"');
  });

  it("keeps open reports only, and one source", () => {
    const reports = merged();
    expect(filterReports(reports, { src: "all", st: "open" })).toHaveLength(3);
    expect(filterReports(reports, { src: "tex", st: "all" }).map((r) => r.src)).toEqual(["tex", "tex", "tex"]);
    expect(filterReports(reports, { src: "content", st: "open" }).map((r) => r.id)).toEqual(["c1"]);
  });

  it("draws the artifact's labels and cards", () => {
    const html = renderReports({ reports: merged(), f: { src: "all", st: "open" }, x: "c1", banner: null });
    for (const label of ["Open", "All", "Everywhere", "In the app", "Texted to Tex"]) expect(html).toMatch(new RegExp(`>${label}[ <]`));
    expect(html).toContain('<button class="card" data-act="sel" data-id="c1" aria-selected="true">');
    expect(html).toContain('<span class="pill team">Tex</span>');
    expect(html).toContain('<span class="pill ">App</span>');
    expect(html).toContain('<span class="pill warn">open</span>');
    expect(html).toContain('<div class="sub">A note shared with them · @amara · 3h ago</div>');
  });

  it("says Nothing open. when the filters leave nothing", () => {
    expect(renderReports({ reports: [], f: { src: "all", st: "open" }, x: null, banner: null })).toContain('<div class="empty">Nothing open.</div>');
  });

  it("shows the Loading state with the tools row while the reports load", () => {
    const html = renderReports({ reports: undefined, f: { src: "all", st: "open" }, x: null, banner: null });
    expect(html).toContain('<div class="tools">');
    expect(html).toContain('<div class="empty">Loading</div>');
  });

  it("shows the desk banner when Tex reports are not open to this person", () => {
    const html = renderReports({ reports: merged().filter((r) => r.src === "content"), f: { src: "all", st: "all" }, x: null, banner: "Tex reports need the pinned bugs workspace; you are not a member." });
    expect(html).toContain('<div class="banner"><span class="tx">Tex reports need the pinned bugs workspace; you are not a member.</span></div>');
  });
});

describe("the side panel", () => {
  it("gives a Tex report its comment, Send to triage and Retire while open", () => {
    const flyer = merged().find((r) => r.title.startsWith("Replied twice"))!;
    const html = renderProps(flyer)!;
    expect(html).toContain('<textarea id="cm"');
    expect(html).toContain("Send to triage");
    expect(html).toContain(`data-act="triage" data-id="${flyer.id}"`);
    expect(html).toContain("Retire");
    expect(html).toContain('data-act="handle"');
  });

  it("gives a content report Mark handled", () => {
    const html = renderProps(merged().find((r) => r.id === "c1"))!;
    expect(html).toContain("Mark handled");
    expect(html).not.toContain('id="cm"');
  });

  it("shows a closed report its handled text and Reopen", () => {
    const html = renderProps(merged().find((r) => r.id === "c2"))!;
    expect(html).toContain("Handled by @staff1 · 2d ago");
    expect(html).toContain('data-act="reopen" data-id="c2"');
    expect(html).not.toContain("Mark handled");
  });

  it("draws the texts as bubbles, Tex's on the right, with the Replay link", () => {
    const table = merged().find((r) => r.title.startsWith("Tex said"))!;
    const html = renderProps(table)!;
    expect(html).toContain('<div class="h">The texts</div>');
    expect(html).toContain('<div class="bub tex">Booked! Lupa, 7pm, party of 2.</div>');
    expect(html).toContain('<div class="bub ">did you book lupa for 7?</div>');
    expect(html).toContain("Open in Replay");
  });

  it("returns null when there is no report to show", () => {
    expect(renderProps(undefined)).toBeNull();
  });

  it("escapes a title with markup in it", () => {
    const hostile: Report = { ...merged()[0]!, id: "c9", title: "<script>alert(1)</script>" };
    const html = renderProps(hostile)!;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const list = renderReports({ reports: [hostile], f: { src: "all", st: "all" }, x: null, banner: null });
    expect(list).not.toContain("<script>");
    expect(esc("<b>")).toBe("&lt;b&gt;");
  });
});

describe("the note's text", () => {
  it("takes the message and the texts from the fenced blocks", () => {
    const text = [
      "---",
      "status: open",
      "reporter: user",
      "texts: shared",
      "---",
      "",
      "# Tex said it booked the table but didn't",
      "",
      "```text",
      "you said 7pm at Lupa was booked",
      "```",
      "",
      "## Their recent texts with Tex",
      "",
      "```text",
      "Them: did you book lupa for 7?",
      "",
      "Tex: Booked! Lupa, 7pm.",
      "Party of 2.",
      "```",
      "",
    ].join("\n");
    expect(parseTexNote(text)).toEqual({
      message: "you said 7pm at Lupa was booked",
      texts: [
        ["them", "did you book lupa for 7?"],
        ["tex", "Booked! Lupa, 7pm.\nParty of 2."],
      ],
    });
  });

  it("has no texts when the person did not share them", () => {
    const text = "---\nstatus: open\n---\n\n# A bug\n\n```text\nit broke\n```\n\nThey did not share their texts with this report.\n";
    expect(parseTexNote(text)).toEqual({ message: "it broke", texts: null });
  });
});

const mockToasts: Array<{ text: string; undo?: () => unknown }> = [];
jest.mock("../features/admin/console/state", () => {
  const actual = jest.requireActual<Record<string, unknown>>("../features/admin/console/state");
  return {
    ...actual,
    toast: (text: string, undo?: () => unknown) => {
      mockToasts.push({ text, undo });
    },
    render: () => undefined,
  };
});

/** An element the acts read: its id, and the side panel's comment box when it has one. */
const el = (id: string, comment?: string) =>
  ({ dataset: { id }, closest: () => ({ querySelector: () => (comment === undefined ? null : { value: comment }) }) }) as unknown as HTMLElement;
const lastToast = () => mockToasts[mockToasts.length - 1]!;

describe("the Reports acts", () => {
  const flyerId = () => merged().find((r) => r.title.startsWith("Replied twice"))!.id;
  const dentistId = () => merged().find((r) => r.title === "Forgot my dentist moved")!.id;
  const flyerPath = () => tex.find((b) => b.title === "Replied twice to one picture")!.path;
  const dentistPath = () => tex.find((b) => b.title === "Forgot my dentist moved")!.path;
  let calls: Array<[string, ...unknown[]]>;
  let failHandledOnUndo: boolean;

  function data(): ReportsData {
    return {
      reports: merged(),
      banner: null,
      call: {
        handled: async (id, handled) => {
          calls.push(["handled", id, handled]);
          if (failHandledOnUndo && !handled) throw { data: { message: "x" } };
        },
        note: async (path, action, comment) => {
          calls.push(["note", path, action, comment]);
        },
        reload: (path) => {
          calls.push(["reload", path]);
        },
      },
    };
  }

  beforeEach(() => {
    calls = [];
    failHandledOnUndo = false;
    mockToasts.length = 0;
  });

  it("marks a content report handled, and Undo reopens it", async () => {
    await reportsPage.acts!.handle!(el("c1"), data());
    expect(calls).toEqual([["handled", "c1", true]]);
    expect(lastToast().text).toBe("Marked handled");
    await lastToast().undo!();
    expect(calls[calls.length - 1]).toEqual(["handled", "c1", false]);
  });

  it("an Undo that fails shows the page's failure toast", async () => {
    failHandledOnUndo = true;
    await reportsPage.acts!.handle!(el("c1"), data());
    await lastToast().undo!();
    expect(lastToast().text).toBe("That did not save. Try again.");
  });

  it("retires a Tex report with the comment, and Undo reopens it", async () => {
    await reportsPage.acts!.handle!(el(flyerId(), "Found it"), data());
    expect(calls).toEqual([
      ["note", flyerPath(), "retire", "Found it"],
      ["reload", flyerPath()],
    ]);
    expect(lastToast().text).toBe("Retired");
    await lastToast().undo!();
    expect(calls.slice(2)).toEqual([
      ["note", flyerPath(), "reopen", undefined],
      ["reload", flyerPath()],
    ]);
  });

  it("sends a Tex report to triage with its comment", async () => {
    await reportsPage.acts!.triage!(el(flyerId(), "Repro: reply twice"), data());
    expect(calls).toEqual([
      ["note", flyerPath(), "triage", "Repro: reply twice"],
      ["reload", flyerPath()],
    ]);
    expect(lastToast().text).toBe("Sent to triage with your comment");
  });

  it("reopens a content report and a Tex report", async () => {
    const d = data();
    const invite = merged().find((r) => r.id === "c2")!;
    await reportsPage.acts!.reopen!(el(invite.id), d);
    expect(calls).toEqual([["handled", "c2", false]]);
    expect(lastToast().text).toBe("Reopened");
    await reportsPage.acts!.reopen!(el(dentistId()), d);
    expect(calls[calls.length - 2]).toEqual(["note", dentistPath(), "reopen", undefined]);
  });
});
