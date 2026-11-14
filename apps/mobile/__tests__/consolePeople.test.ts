/**
 * The People page's model, HTML and props against the artifact's (`staff-console.html`, `P.people`).
 * Fixtures are fake: every name, address and phone here is invented.
 */
import { render, props } from "../features/admin/console/pages/people/render";
import { rowsOf, texView, type ConsolePeople, type PeopleData, type TexLine } from "../features/admin/console/pages/people/model";
import { S } from "../features/admin/console/state";

const ms = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

const people = (): ConsolePeople =>
  ({
    accounts: [
      {
        userId: "u_maya",
        name: "Maya Lindqvist",
        handle: "maya",
        emails: ["maya@example.com"],
        phone: "+1 555 555 0142",
        textingPhones: [],
        joinedAt: ms(2026, 8, 2),
        archived: false,
        lastSeenAt: Date.now() - 2 * 3600_000,
        from: "friend",
        invitedBy: "amara",
        workspaces: [
          { slug: "maya", kind: "personal", role: "owner" },
          { slug: "fieldwork", kind: "shared", role: "editor" },
        ],
        clients: [{ name: "Claude", lastUsedAt: Date.now() - 2 * 3600_000 }],
        aiUsd: 41.2,
        aiByFeature: [{ label: "Tex replies", usd: 30.1 }],
      },
      {
        userId: "u_ben",
        name: null,
        handle: null,
        emails: ["ben@example.org"],
        phone: null,
        textingPhones: [],
        joinedAt: ms(2026, 8, 27),
        archived: true,
        lastSeenAt: null,
        from: "direct",
        invitedBy: null,
        workspaces: [{ slug: "ben", kind: "personal", role: "owner" }],
        clients: [],
        aiUsd: 0,
        aiByFeature: [],
      },
      {
        userId: "u_img",
        name: "<img src=x onerror=alert(1)>",
        handle: "imgy",
        emails: ["img@example.net"],
        phone: "+1 555 555 0199",
        textingPhones: [],
        joinedAt: ms(2026, 11, 12),
        archived: false,
        lastSeenAt: null,
        from: "waitlist",
        invitedBy: null,
        workspaces: [],
        clients: [],
        aiUsd: 0,
        aiByFeature: [],
      },
    ],
    waitlist: [
      { id: "w_wait", who: "dana@example.com", status: "waiting", joinedAt: ms(2026, 11, 13), from: "waitlist", campaign: null, useFor: "A home for notes.", told: true },
      { id: "w_in", who: "+1 401 555 0181", status: "admitted", joinedAt: ms(2026, 10, 30), from: "ad", campaign: "fall-family", useFor: null, told: false },
      { id: "w_rm", who: "spam@example.com", status: "removed", joinedAt: ms(2026, 10, 22), from: "staff", campaign: null, useFor: null, told: true },
    ],
    invites: [
      { id: "i_pending", to: "cole@example.com", inviterHandle: "maya", sentAt: ms(2026, 11, 12), status: "pending" },
    ],
    invitesOff: false,
    truncated: false,
  }) as unknown as ConsolePeople;

const tex: TexLine = {
  state: "shared",
  line: "+1 555 555 0100",
  cap: 20,
  contacts: [
    { phone: "+1 555 555 0142", addedAt: null, person: { name: "Maya", email: null, username: "maya", linked: true } },
    { phone: "+1 555 555 0166", addedAt: null, person: null },
  ],
} as TexLine;

const data = (over: Partial<PeopleData> = {}): PeopleData => ({
  people: people(),
  mailOpen: new Set(["u_maya"]),
  tex,
  acct: undefined,
  m: {} as PeopleData["m"],
  ...over,
});

beforeEach(() => {
  S.p = "people";
  S.f = { aud: "all", ans: "0", told: "all", ps: "all", cf: "all", sort: "lastup" };
  S.q = "";
  S.x = null;
  S.sel = new Set();
  S.confirm = null;
  S.adding = false;
});

describe("model: the artifact's statuses", () => {
  it("maps accounts, waitlist and invites to the artifact's status keys", () => {
    const rows = rowsOf(people());
    const st = (id: string) => rows.find((r) => r.id === id)?.st;
    expect(st("u_maya")).toBe("acct");
    expect(st("u_ben")).toBe("archived");
    expect(st("w_wait")).toBe("waiting");
    expect(st("w_in")).toBe("in");
    expect(st("w_rm")).toBe("removed");
    expect(st("i_pending")).toBe("invited");
    expect(rows.find((r) => r.id === "w_in")?.told).toBe(false);
  });

  it("names came-from as the artifact does and shows a friend's inviter", () => {
    const rows = rowsOf(people());
    expect(rows.find((r) => r.id === "u_maya")).toMatchObject({ from: "Friend", by: "amara", when: "Aug 2" });
    expect(rows.find((r) => r.id === "u_ben")?.from).toBe("Direct");
    expect(rows.find((r) => r.id === "w_in")?.from).toBe("Ad");
    expect(rows.find((r) => r.id === "w_rm")?.from).toBe("Staff");
  });

  it("uses the name, and the handle line under it", () => {
    const rows = rowsOf(people());
    expect(rows.find((r) => r.id === "u_maya")).toMatchObject({ name: "Maya Lindqvist", sub: "@maya" });
    expect(rows.find((r) => r.id === "u_ben")).toMatchObject({ name: "ben@example.org", sub: "" });
  });

  it("reads Tex's list: unowned numbers, the slot count, and what unlimited means", () => {
    const view = texView(tex);
    expect(view).toMatchObject({ state: "shared", cap: 20, used: 2, full: false });
    expect(view.state === "shared" && view.unowned).toEqual(["+1 555 555 0166"]);
    expect(texView(undefined).state).toBe("loading");
  });
});

describe("render", () => {
  it("draws the artifact's tools row with counts, the two toggles and Add people", () => {
    const html = render(data());
    expect(html).toContain('<select class="search" style="max-width:170px" data-act="psel" aria-label="Status">');
    expect(html).toContain('<option value="all" selected>Everyone (5)</option>');
    expect(html).toContain('<option value="waiting" >Waiting (1)</option>');
    expect(html).toContain('<select class="search" style="max-width:190px" data-act="cf" aria-label="Came from">');
    expect(html).toContain('<option value="all" selected>Came from anywhere</option>');
    expect(html).toContain('<button class="ghost" aria-pressed="false" data-act="answered" style="">Answered the question</button>');
    expect(html).toContain('<button class="ghost" aria-pressed="false" data-act="toldf" data-v="no" style="">Never told they\'re in</button>');
    expect(html).toContain('<button class="primary" data-act="addppl">Add people</button>');
  });

  it("names the bulk bar for a selection, and offers only what applies", () => {
    S.sel = new Set(["w_wait", "w_in"]);
    const html = render(data());
    expect(html).toContain('<div class="bulk"><b>2 selected</b>');
    expect(html).toContain('data-act="askbulk" data-v="letin">Let 1 in</button>');
    expect(html).toContain('data-act="askbulk" data-v="tell">Text 1 they\'re in</button>');
    expect(html).not.toContain('data-v="remove">Remove 2');
    expect(html).toContain('<button class="link" data-act="clearsel">Clear</button>');
  });

  it("shows the not-told banner for let-in phone rows", () => {
    expect(render(data())).toContain("<b>1 person was</b> let in by phone but never got the text.");
  });

  it("shows the Numbers with no account panel with the unowned number and its remove", () => {
    const html = render(data());
    expect(html).toContain("Numbers with no account");
    expect(html).toContain("Tex line: 2 of 20 used");
    expect(html).toContain('<button class="ghost" data-act="askunown" data-id="+1 555 555 0166">Remove</button>');
    expect(html).toContain('<button class="ghost" data-act="addnum">Let it text Tex</button>');
  });

  it("drops the 'of 20' wording when the list is unlimited", () => {
    const html = render(data({ tex: { state: "unlimited", line: null } }));
    expect(html).toContain("Tex line: 2 used");
    expect(html).not.toContain("of 20");
  });

  it("shows the truncated banner above the table", () => {
    const d = data();
    d.people = { ...people(), truncated: true };
    expect(render(d)).toContain("Showing the newest people only; some were left out.");
  });

  it("shows a loading placeholder before the list arrives", () => {
    const html = render(undefined);
    expect(html).toContain('<div class="empty">Loading</div>');
    expect(html).toContain('<button class="primary" data-act="addppl">Add people</button>');
  });

  it("escapes every name, handle and address from the database", () => {
    const html = render(data());
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("props", () => {
  it("shows an account's email, phone, workspaces and archive control", () => {
    const html = props(data(), "u_maya", Date.now()) ?? "";
    expect(html).toContain('<h3 tabindex="-1">Maya Lindqvist');
    expect(html).toContain("Email");
    expect(html).toContain("Phone");
    expect(html).toContain("Workspaces");
    expect(html).toContain('<button class="ghost danger" data-act="archive" data-id="u_maya">Archive</button>');
    expect(html).toContain("Known senders only");
    expect(html).toContain("invited by @amara");
  });

  it("shows an archived account as Unarchive", () => {
    const html = props(data(), "u_ben") ?? "";
    expect(html).toContain('<button class="ghost" data-act="archive" data-id="u_ben">Unarchive</button>');
    expect(html).toContain("Can text Tex");
  });

  it("returns null for a row that is not picked", () => {
    expect(props(data(), "nope")).toBeNull();
    expect(props(data(), "w_wait")).toBeNull();
  });

  it("shows an invite's history", () => {
    const html = props(data(), "i_pending") ?? "";
    expect(html).toContain("Invited by <b>@maya</b> on Nov 12");
    expect(html).toContain("Not used yet");
  });

  it("escapes a name with markup in the side panel", () => {
    const html = props(data(), "u_img") ?? "";
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
  });
});
