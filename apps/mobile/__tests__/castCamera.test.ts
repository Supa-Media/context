import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { CAST_PEEK_MS, castPeek, folderShowing, followWorkspace, scenePage, type Peek } from "../features/home/cast/castCamera";

/*
  On a phone, Context's window shows each chat step's folder while it lands
  (Dev2, 2026-09-30: "I'd like to show how folders and things are being
  created as you chat").
*/

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("folderShowing", () => {
  test("a made thing shows the folder it landed in", () => {
    expect(folderShowing("made", "1-projects/beta-launch")).toBe("1-projects");
    expect(folderShowing("made", "1-projects/beta-launch/launch decisions.md")).toBe("1-projects/beta-launch");
    expect(folderShowing("made", "4-archive/website")).toBe("4-archive");
  });

  test("a project's status shows the folder whose List has it", () => {
    expect(folderShowing("status", "1-projects/beta-launch/overview.md")).toBe("1-projects");
    expect(folderShowing("status", "1-projects/beta-launch/README.md")).toBe("1-projects");
    // A task's status is a row in its own project's List.
    expect(folderShowing("status", "1-projects/beta-launch/ship it.md")).toBe("1-projects/beta-launch");
  });

  test("something at the top shows the top", () => {
    expect(folderShowing("made", "inbox")).toBe("");
    expect(folderShowing("status", "beta/overview.md")).toBe("");
  });
});

describe("followWorkspace", () => {
  const steps = () => ({
    addFolder: jest.fn((path: string) => path as string | null),
    move: jest.fn((path: string, into: string) => `${into}/${path.split("/").pop()}` as string | null),
    rename: jest.fn((_path: string, _name: string) => null as string | null),
    setStatus: jest.fn((path: string, _status: string) => `${path}/overview.md` as string | null),
    addTask: jest.fn((project: string, text: string) => `${project}/${text}.md` as string | null),
    addNoteIn: jest.fn((folder: string, name: string, _text: string) => `${folder}/${name}.md` as string | null),
  });

  test("each step that lands names its folder, and still does its work", () => {
    const shown: string[] = [];
    const inner = steps();
    const workspace = followWorkspace(inner, (folder) => shown.push(folder));
    expect(workspace.addFolder("1-projects/beta-launch")).toBe("1-projects/beta-launch");
    workspace.move("1-projects/website", "4-archive");
    workspace.setStatus("1-projects/beta-launch", "in progress");
    workspace.addTask("1-projects/beta-launch", "ship it");
    workspace.addNoteIn("1-projects/beta-launch", "decisions", "- Oct 14");
    expect(shown).toEqual(["1-projects", "4-archive", "1-projects", "1-projects/beta-launch", "1-projects/beta-launch"]);
    expect(inner.move).toHaveBeenCalledWith("1-projects/website", "4-archive");
  });

  test("a step that did nothing shows nothing", () => {
    const shown: string[] = [];
    followWorkspace(steps(), (folder) => shown.push(folder)).rename("nowhere", "else");
    expect(shown).toEqual([]);
  });
});

describe("castPeek", () => {
  function page(enabled = true, start: string | null = "welcome.md") {
    const state = { selected: start, opened: [] as string[] };
    const select = (path: string) => {
      state.selected = path;
      state.opened.push(path);
    };
    const peeker = castPeek(() => ({ enabled: () => enabled, selected: state.selected, select }));
    return { state, ...peeker };
  }

  test("shows the folder, then goes back to the scene's page", () => {
    const { state, peek } = page();
    peek("1-projects");
    expect(state.selected).toBe("1-projects");
    jest.advanceTimersByTime(CAST_PEEK_MS - 1);
    expect(state.selected).toBe("1-projects");
    jest.advanceTimersByTime(1);
    expect(state.selected).toBe("welcome.md");
  });

  test("steps close together go back to where the first one started", () => {
    const { state, peek } = page();
    peek("1-projects");
    jest.advanceTimersByTime(1000);
    peek("4-archive");
    jest.advanceTimersByTime(CAST_PEEK_MS);
    expect(state.opened).toEqual(["1-projects", "4-archive", "welcome.md"]);
  });

  test("a page the scene opened meanwhile stays", () => {
    const { state, peek } = page();
    peek("1-projects");
    state.selected = "pricing.md";
    jest.advanceTimersByTime(CAST_PEEK_MS);
    expect(state.selected).toBe("pricing.md");
  });

  test("off on a wide screen, and never for the top", () => {
    const wide = page(false);
    wide.peek("1-projects");
    expect(wide.state.opened).toEqual([]);
    const phone = page();
    phone.peek("");
    expect(phone.state.opened).toEqual([]);
  });

  test("stopping cancels the way back", () => {
    const { state, peek, stop } = page();
    peek("1-projects");
    stop();
    jest.advanceTimersByTime(CAST_PEEK_MS * 2);
    expect(state.opened).toEqual(["1-projects"]);
  });
});

describe("the scene's page during a peek", () => {
  test("a folder up for a moment is still the scene's page, so its show plays on", () => {
    const peeks: (Peek | null)[] = [];
    const state = { selected: "welcome.md" as string | null };
    const { peek } = castPeek(() => ({
      enabled: () => true,
      selected: state.selected,
      select: (path) => {
        state.selected = path;
      },
      peeking: (one) => peeks.push(one),
    }));
    peek("1-projects");
    expect(peeks).toEqual([{ home: "welcome.md", folder: "1-projects" }]);
    expect(scenePage(state.selected, peeks[0]!)).toBe("welcome.md");
    jest.advanceTimersByTime(CAST_PEEK_MS);
    expect(peeks[1]).toBeNull();
    expect(scenePage(state.selected, null)).toBe("welcome.md");
  });

  test("anything else opened meanwhile is the page", () => {
    expect(scenePage("pricing.md", { home: "welcome.md", folder: "1-projects" })).toBe("pricing.md");
  });
});
