/**
 * @jest-environment jsdom
 */

/**
 * The connect rows, mounted and pressed.
 *
 * `clientProviders.test.ts` proves the catalogue is right. This proves the
 * pane is wired to it — which is a separate failure, and the more likely one:
 * a row that renders a perfectly correct deep link and never hands it to
 * anything is indistinguishable from a working row until somebody clicks it.
 *
 * Two things it holds down that nothing else can:
 *
 *  1. **A `cursor://` link is assigned, not `window.open`ed.** The split lives
 *     in `open.web.ts`, which only runs in a browser — and only runs in this
 *     suite at all because jest resolves `.web.ts` first (see `jest.config.js`).
 *     A regression to a single `window.open` for both leaves a blank tab behind
 *     on every one-click install and passes every other test here.
 *  2. **Rows stay shut until asked.** Eight providers' worth of copy fields
 *     rendered at once is the thing the accordion exists to prevent, and
 *     "render them all, hide them with a style" would look identical in a
 *     screenshot.
 *
 * `react-native-web` renders these to real DOM, so the clicks below are the
 * clicks a person makes.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ConnectClients } from "../features/console/clients/ConnectClients";
import { CLIENT_PROVIDERS, CUSTOMIZATION_INSTRUCTION } from "../features/console/clients/providers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://mcp.example.test/mcp";

interface Screen {
  q: (testID: string) => HTMLElement | null;
  text: () => string;
  click: (testID: string) => void;
  opened: string[];
  assigned: string[];
  unmount: () => void;
}

function mount(
  clients: readonly { name: string }[] = [],
  onConnectAgent?: (agent: string) => void,
): Screen {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  const opened: string[] = [];
  const assigned: string[] = [];

  // jsdom refuses to navigate and logs "not implemented"; both are replaced so
  // the test observes the call rather than the navigation.
  jest.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: (url: string) => assigned.push(url) },
  });

  act(() => {
    root.render(createElement(ConnectClients, { endpoint: ENDPOINT, clients, onConnectAgent }));
  });

  const q = (testID: string) =>
    container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

  return {
    q,
    text: () => container.textContent ?? "",
    click: (testID: string) => {
      const element = q(testID);
      if (element === null) throw new Error(`no control called ${testID}`);
      act(() => {
        element.click();
      });
    },
    opened,
    assigned,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the rows", () => {
  test("every provider in the catalogue gets a row and a link button", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      expect(screen.q(`provider-${provider.id}`)).not.toBeNull();
      expect(screen.q(`provider-${provider.id}-open`)).not.toBeNull();
    }
    screen.unmount();
  });

  test("nothing is on screen to copy until a row is opened", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      expect(screen.q(`provider-${provider.id}-details`)).toBeNull();
    }
    expect(screen.text()).not.toContain(ENDPOINT);
    screen.unmount();
  });

  test("opening a row shows that client's fields, and only that client's", () => {
    const screen = mount();
    screen.click("provider-chatgpt-toggle");

    expect(screen.q("provider-chatgpt-details")).not.toBeNull();
    expect(screen.q("provider-chatgpt-url")).not.toBeNull();
    expect(screen.q("provider-claude-details")).toBeNull();
    expect(screen.text()).toContain(ENDPOINT);

    // A second row replaces the first rather than stacking.
    screen.click("provider-claude-toggle");
    expect(screen.q("provider-claude-details")).not.toBeNull();
    expect(screen.q("provider-chatgpt-details")).toBeNull();

    // And the same row again closes it.
    screen.click("provider-claude-toggle");
    expect(screen.q("provider-claude-details")).toBeNull();
    screen.unmount();
  });

  test("ChatGPT offers a name, an optional description, and the URL", () => {
    const screen = mount();
    screen.click("provider-chatgpt-toggle");

    expect(screen.q("provider-chatgpt-name")).not.toBeNull();
    expect(screen.q("provider-chatgpt-description")).not.toBeNull();
    expect(screen.q("provider-chatgpt-url")).not.toBeNull();
    expect(screen.text()).toContain("optional");
    screen.unmount();
  });

  test("a CLI client offers commands carrying the endpoint, not a form", () => {
    const screen = mount();
    screen.click("provider-codex-toggle");

    const add = screen.q("provider-codex-add");
    expect(add).not.toBeNull();
    expect(add!.textContent).toContain(`--url ${ENDPOINT}`);
    expect(screen.q("provider-codex-name")).toBeNull();
    screen.unmount();
  });
});

describe("what is already connected", () => {
  test("a connected client ticks its own row and no other", () => {
    const screen = mount([{ name: "ChatGPT" }]);

    expect(screen.q("provider-chatgpt-connected")).not.toBeNull();
    expect(screen.q("provider-claude-connected")).toBeNull();
    expect(screen.q("provider-cursor-connected")).toBeNull();
    screen.unmount();
  });

  /*
   * The load-bearing half of the matching. "Claude Code" matches /claude/ as
   * well, so a catalogue-order scan ticks the Claude row for every terminal and
   * leaves Claude Code reading as unconnected — the person then connects it a
   * second time and wonders why their Claude row was already ticked.
   */
  test("Claude Code ticks Claude Code, not Claude", () => {
    const screen = mount([{ name: "Claude Code" }]);

    expect(screen.q("provider-claude-code-connected")).not.toBeNull();
    expect(screen.q("provider-claude-connected")).toBeNull();
    screen.unmount();
  });

  test("a second account of the same client counts, and the button offers another", () => {
    const screen = mount([{ name: "Claude" }, { name: "claude.ai" }]);

    expect(screen.q("provider-claude-connected")!.textContent).toContain("2 connected");
    expect(screen.q("provider-claude-open")!.textContent).toContain("Connect another");
    // Never disabled: a work account and a personal one are two grants, each
    // revocable on its own, so there is nothing here to have "already done".
    expect(screen.q("provider-claude-open")!.getAttribute("disabled")).toBeNull();
    screen.unmount();
  });

  /*
   * The name belongs to the client, so a miss is always possible. It must leave
   * the row looking unconnected — the grant is still listed in full under
   * Connected clients — rather than ticking a row at random, because a row that
   * claims a connection nobody made is somebody concluding their tool is set up
   * when it is not.
   */
  test("an unrecognised client ticks nothing", () => {
    const screen = mount([{ name: "some in-house agent" }]);

    for (const provider of CLIENT_PROVIDERS) {
      expect(screen.q(`provider-${provider.id}-connected`)).toBeNull();
    }
    screen.unmount();
  });

  test("the row is a name and a button; the caveats wait for Details", () => {
    const screen = mount();
    const chatgpt = CLIENT_PROVIDERS.find((provider) => provider.id === "chatgpt")!;

    expect(screen.text()).not.toContain(chatgpt.note);
    screen.click("provider-chatgpt-toggle");
    expect(screen.text()).toContain(chatgpt.note);
    screen.unmount();
  });
});

describe("the hooks panel", () => {
  /*
   * The catalogue said Claude Code was the only client with documented hooks.
   * That was asserted from memory and was false — Codex and Gemini CLI both
   * had them. Pinned by name so the next person to add or remove one has to
   * mean it, rather than discovering months later that a row quietly lost its
   * button.
   */
  test("the clients `npx @supa-media/context install` covers offer it, and the others do not", () => {
    // Claude Code, Codex and Gemini CLI get the plugin (MCP, skills, hooks);
    // Cursor and VS Code get the MCP entry and the skills.
    const withHook = CLIENT_PROVIDERS.filter((provider) => provider.hook).map((p) => p.id).sort();
    expect(withHook).toEqual(["claude-code", "codex", "cursor", "gemini-cli", "vscode"]);
  });

  test("each hook command names its own client", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS.filter((p) => p.hook)) {
      screen.click(`provider-${provider.id}-hook-toggle`);
      const text = screen.q(`provider-${provider.id}-hook-command`)!.textContent;
      expect(text).toContain(`--agent ${provider.id}`);
      // `--client` belonged to @supa-media/context-hook. The new installer does
      // not read it, so a command still carrying it would install into every
      // agent on the machine instead of the one this row is about.
      expect(text).not.toContain("--client");
    }
    screen.unmount();
  });

  test("only clients with a real hook offer one", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      const button = screen.q(`provider-${provider.id}-hook-toggle`);
      // Present exactly where a hook exists. A button on a client whose
      // end-of-session event we would be guessing at is worse than none: the
      // person believes their sessions are being saved and finds out months
      // later that none of them were.
      expect(button === null).toBe(provider.hook === undefined);
    }
    screen.unmount();
  });

  test("it carries the install command for the endpoint the pane was given", () => {
    const screen = mount();
    screen.click("provider-claude-code-hook-toggle");

    const command = screen.q("provider-claude-code-hook-command");
    expect(command).not.toBeNull();
    expect(command!.textContent).toContain("@supa-media/context install");
    expect(command!.textContent).toContain(ENDPOINT);
    screen.unmount();
  });

  test("hooks and details are separate panels, and one at a time", () => {
    const screen = mount();

    screen.click("provider-claude-code-hook-toggle");
    expect(screen.q("provider-claude-code-hook")).not.toBeNull();
    expect(screen.q("provider-claude-code-details")).toBeNull();

    screen.click("provider-claude-code-toggle");
    expect(screen.q("provider-claude-code-details")).not.toBeNull();
    expect(screen.q("provider-claude-code-hook")).toBeNull();

    screen.click("provider-claude-code-toggle");
    expect(screen.q("provider-claude-code-details")).toBeNull();
    screen.unmount();
  });

  test("the plugin panel says what access it asks for, and that sessions are saved", () => {
    // The installer signs in with read and write, asks for private notes with
    // the choice left to the approval page, and turns capture on. All three are
    // things a person should read before running it, not discover afterwards.
    const screen = mount();
    screen.click("provider-claude-code-hook-toggle");
    expect(screen.text()).toContain("read and write access; on the approval page you choose whether it also sees your private notes");
    expect(screen.text()).toContain("config set capture off");
    screen.unmount();
  });

  /*
    AND WHERE THE SIGN-IN IS KEPT, WHICH IS THE HALF A READER CANNOT INFER.

    This panel used to say the installer asked for "capture access only — it
    can add to your inbox and cannot read a single note", and it warned, for
    the narrower `--orient` variant, about "a credential that lives on your
    machine unattended". The grant is now read, write and — if the approval
    page is allowed to — private. The scopes are stated; where the resulting
    sign-in lives was not, and it is the fact that decides whether somebody
    runs this on a shared or a work machine.

    Three claims, each true of the code rather than of the copy:
    `plugins/context/src/config.js` writes with `FILE_MODE = 0o600` and opens
    `"wx", 0o600` rather than writing then chmod-ing; the sign-in keeps working
    with nobody present, which is the point of a session hook; and Connections
    is where it is revoked, which is the one action a reader can take.
  */
  test("...and where the sign-in is kept, for every client that offers it", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS.filter((p) => p.hook)) {
      screen.click(`provider-${provider.id}-hook-toggle`);
      const text = screen.text();
      expect(text).toContain("kept on this computer");
      expect(text).toContain("only your user can read");
      expect(text).toContain("revoke it in Connections");
      screen.click(`provider-${provider.id}-hook-toggle`);
    }
    screen.unmount();
  });
});

describe("the customization instruction", () => {
  /*
   * A connector grant makes `orient` reachable; it does not make a client
   * call it every turn. This is the row's answer to that, and it has to
   * survive on every one of the nine rows or the education this project set
   * out to add is really "education for six of nine clients".
   */
  test("every row offers it, once its details are open", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      screen.click(`provider-${provider.id}-toggle`);
      const field = screen.q(`provider-${provider.id}-customization`);
      expect(field).not.toBeNull();
      expect(field!.textContent).toContain(CUSTOMIZATION_INSTRUCTION);
      screen.click(`provider-${provider.id}-toggle`);
    }
    screen.unmount();
  });

  test("it is one line and names the tool an agent has to call", () => {
    const screen = mount();
    screen.click("provider-claude-toggle");

    const field = screen.q("provider-claude-customization");
    expect(field!.textContent).toContain(CUSTOMIZATION_INSTRUCTION);
    expect(CUSTOMIZATION_INSTRUCTION).not.toContain("\n");
    expect(CUSTOMIZATION_INSTRUCTION).toContain("orient");
    screen.unmount();
  });

  test("each row also says where to paste it", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      screen.click(`provider-${provider.id}-toggle`);
      expect(screen.q(`provider-${provider.id}-details`)!.textContent).toContain(
        provider.customization.hint,
      );
      screen.click(`provider-${provider.id}-toggle`);
    }
    screen.unmount();
  });
});

describe("pressing the link button", () => {
  test("a hosted connector page opens in a new tab", () => {
    const screen = mount();
    screen.click("provider-claude-open");

    expect(screen.assigned).toEqual([]);
    expect(screen.opened).toHaveLength(1);
    expect(screen.opened[0]).toBe(
      "https://claude.ai/customize/connectors?modal=add-custom-connector",
    );
    screen.unmount();
  });

  test("an app-scheme install navigates in place, leaving no blank tab", () => {
    const screen = mount();
    screen.click("provider-cursor-open");

    expect(screen.opened).toEqual([]);
    expect(screen.assigned).toHaveLength(1);
    expect(screen.assigned[0].startsWith("cursor://anysphere.cursor-deeplink/mcp/install?")).toBe(
      true,
    );
    screen.unmount();
  });

  test("every button carries the endpoint the pane was given", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      screen.click(`provider-${provider.id}-open`);
    }

    const hrefs = [...screen.opened, ...screen.assigned];
    expect(hrefs).toHaveLength(CLIENT_PROVIDERS.length);
    for (const href of hrefs) {
      expect(href).not.toContain("context.lc");
    }
    screen.unmount();
  });
});

describe("Claude and ChatGPT, where the full screen guide can open", () => {
  test("their button opens the guide, not the client, and nothing else does", () => {
    const guided: string[] = [];
    const screen = mount([], (agent) => guided.push(agent));
    screen.click("provider-claude-open");
    screen.click("provider-chatgpt-open");

    expect(guided).toEqual(["claude", "chatgpt"]);
    expect([...screen.opened, ...screen.assigned]).toEqual([]);

    // Every other client still goes straight to its own screen.
    screen.click("provider-codex-toggle");
    expect(screen.q("provider-codex-details")).not.toBeNull();
    screen.click("provider-cursor-open");
    expect(guided).toEqual(["claude", "chatgpt"]);
    expect(screen.assigned).toHaveLength(1);
    screen.unmount();
  });

  test("they have no inline Details panel beside the guide", () => {
    const screen = mount([], () => {});
    expect(screen.q("provider-claude-toggle")).toBeNull();
    expect(screen.q("provider-chatgpt-toggle")).toBeNull();
    expect(screen.q("provider-codex-toggle")).not.toBeNull();
    screen.unmount();
  });

  test("connect another is the guide too, once one is connected", () => {
    const guided: string[] = [];
    const screen = mount([{ name: "ChatGPT" }], (agent) => guided.push(agent));
    expect(screen.q("provider-chatgpt-open")?.textContent).toContain("Connect another");
    screen.click("provider-chatgpt-open");
    expect(guided).toEqual(["chatgpt"]);
    expect(screen.opened).toEqual([]);
    screen.unmount();
  });
});
