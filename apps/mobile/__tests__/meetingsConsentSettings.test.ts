/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  CLOUD_TRANSCRIPTION_CONSENT_VERSION,
  TRANSCRIPTION_CONSENT_COPY,
  TRANSCRIPTION_SETTINGS_COPY,
} from "@context/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Taking the yes back, and the account's answer reaching this device
 * (`docs/decisions/meetings/transcription-consent.md`).
 *
 *  - Settings › Meetings shows the answer whatever it is, and Turn off stops
 *    this device before the account has heard: nothing more is sent and audio
 *    still waiting here is deleted, even if the save fails.
 *  - `useTranscriptionConsentSync` hands the live answer to the recorders.
 *    Loading and signed out are no; a definite no (withdrawn on another
 *    device, say) empties the spool.
 *
 * ## Sabotage record
 *
 * Each applied, suite run, named test failed, reverted.
 *
 *  1. Turn off calls the mutation without clearing this device first.
 *     → `Turn off stops this device even when the account cannot be told` fails.
 *  2. The sync hook treats a loading answer as the last yes.
 *     → `loading is no` fails.
 *  3. The sync hook stops calling `forgetSpooledAudio` on a no.
 *     → `a no from the account empties the spool` fails.
 *  4. Turn off no longer keeps itself on the device (`rememberWithdrawal` dropped).
 *     → the restart tests and `Allow from a New meeting clears it…` fail.
 *  5. One key for every account instead of one per account.
 *     → `another account's no does not clear it` fails.
 *  6. Allow in the dialog leaves the kept Turn off in place.
 *     → `Allow from a New meeting clears it…` fails.
 *  7. The sync hook ignores a kept Turn off.
 *     → the restart tests fail.
 *  8. An unreadable store read as "nothing kept".
 *     → `a kept Turn off that cannot be read…` fails.
 */

const mockForget = jest.fn(() => ({ left: 0 }));
jest.mock("../features/meetings/capture/spoolDrain", () => {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const actual = jest.requireActual("../features/meetings/capture/spoolDrain") as Record<string, unknown>;
  return { ...actual, forgetSpooledAudio: () => mockForget() };
});

let mockAnswer: unknown = undefined;
const mockMutations: string[] = [];
let mockMutationFails = false;
jest.mock("convex/react", () => {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const actual = jest.requireActual("convex/react") as Record<string, unknown>;
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const run = async (ref: unknown) => {
    mockMutations.push(getFunctionName(ref as never));
    if (mockMutationFails) throw new Error("offline");
    return null;
  };
  return {
    ...actual,
    useConvex: () => ({ mutation: run }),
    useQuery: () => mockAnswer,
    useMutation: (ref: unknown) => () => run(ref),
  };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { CloudTranscriptionSettings } =
  require("../features/console/settings/panels/CloudTranscriptionSettings") as typeof import("../features/console/settings/panels/CloudTranscriptionSettings");
const { useTranscriptionConsentSync, useTranscriptionConsentGate } =
  require("../features/meetings/useTranscriptionConsent") as typeof import("../features/meetings/useTranscriptionConsent");
const { setWithdrawalStore } =
  require("../features/meetings/transcriptionWithdrawal") as typeof import("../features/meetings/transcriptionWithdrawal");
const { memoryStore } = require("../features/offline/memory") as typeof import("../features/offline/memory");
const { cloudTranscriptionAllowed, setTranscriptionConsent, transcriptionWithdrawalConfirmed } =
  require("../features/meetings/capture") as typeof import("../features/meetings/capture");
/* eslint-enable @typescript-eslint/no-require-imports */

const V = CLOUD_TRANSCRIPTION_CONSENT_VERSION;
const ACCOUNT = "user_one";
const ON = { allowed: true, answeredVersion: V, currentVersion: V, outdated: false, grantedAt: 1, withdrawnAt: null, account: ACCOUNT };
const OFF = { allowed: false, answeredVersion: V, currentVersion: V, outdated: false, grantedAt: 1, withdrawnAt: 2, account: ACCOUNT };
const NEVER = { allowed: false, answeredVersion: null, currentVersion: V, outdated: false, grantedAt: null, withdrawnAt: null, account: ACCOUNT };
const OLD = { allowed: false, answeredVersion: V - 1, currentVersion: V, outdated: true, grantedAt: 1, withdrawnAt: null, account: ACCOUNT };

function mount(element: ReactElement): { rerender: (next: ReactElement) => void; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function press(testId: string): void {
  const target = document.body.querySelector(`[data-testid="${testId}"]`);
  if (target === null) throw new Error(`no control named ${testId}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function shown(testId: string): boolean {
  return document.body.querySelector(`[data-testid="${testId}"]`) !== null;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

/** This device's durable store, which outlives a restart. */
let device: ReturnType<typeof memoryStore>;

/** A restart: the process forgets everything, the device's store does not. */
function restart(): void {
  setWithdrawalStore(device);
  transcriptionWithdrawalConfirmed();
  setTranscriptionConsent(null);
}

beforeEach(() => {
  document.body.replaceChildren();
  mockAnswer = undefined;
  mockMutations.length = 0;
  mockMutationFails = false;
  mockForget.mockClear();
  device = memoryStore();
  setWithdrawalStore(device);
  transcriptionWithdrawalConfirmed();
  setTranscriptionConsent(null);
});

afterEach(() => setTranscriptionConsent(null));

describe("Settings › Meetings, Cloud transcription", () => {
  test("a yes shows as on, with Turn off", () => {
    mockAnswer = ON;
    const { unmount } = mount(createElement(CloudTranscriptionSettings));
    expect(document.body.textContent).toContain(TRANSCRIPTION_SETTINGS_COPY.on);
    expect(shown("cloud-transcription-turn-off")).toBe(true);
    unmount();
  });

  test("an account that said no still sees the row, and that it is off", () => {
    for (const answer of [OFF, NEVER]) {
      mockAnswer = answer;
      const { unmount } = mount(createElement(CloudTranscriptionSettings));
      expect(document.body.textContent).toContain(TRANSCRIPTION_SETTINGS_COPY.off);
      expect(shown("cloud-transcription-allow")).toBe(true);
      unmount();
    }
  });

  test("a yes to an older disclosure says it has to be given again", () => {
    mockAnswer = OLD;
    const { unmount } = mount(createElement(CloudTranscriptionSettings));
    expect(document.body.textContent).toContain(TRANSCRIPTION_SETTINGS_COPY.outdated);
    unmount();
  });

  test("Turn off stops this device, deletes waiting audio, and tells the account", async () => {
    mockAnswer = ON;
    setTranscriptionConsent(V);
    const { unmount } = mount(createElement(CloudTranscriptionSettings));

    press("cloud-transcription-turn-off");
    await settle();

    expect(cloudTranscriptionAllowed()).toBe(false);
    expect(mockForget).toHaveBeenCalled();
    expect(mockMutations).toEqual(["functions/transcriptionConsent:withdrawTranscription"]);
    unmount();
  });

  test("Turn off stops this device even when the account cannot be told", async () => {
    mockAnswer = ON;
    mockMutationFails = true;
    setTranscriptionConsent(V);
    const { unmount } = mount(createElement(CloudTranscriptionSettings));

    press("cloud-transcription-turn-off");
    expect(cloudTranscriptionAllowed()).toBe(false);
    await settle();

    expect(cloudTranscriptionAllowed()).toBe(false);
    expect(shown("cloud-transcription-unsaved")).toBe(true);
    unmount();
  });

  test("Allow shows the same dialog a New meeting does, and only its Allow says yes", async () => {
    mockAnswer = NEVER;
    const { unmount } = mount(createElement(CloudTranscriptionSettings));

    press("cloud-transcription-allow");
    await settle();
    expect(document.body.textContent).toContain(TRANSCRIPTION_CONSENT_COPY.body);
    expect(mockMutations).toEqual([]);

    press("transcription-consent-allow");
    await settle();
    expect(mockMutations).toEqual(["functions/transcriptionConsent:allowTranscription"]);
    expect(cloudTranscriptionAllowed()).toBe(true);
    unmount();
  });
});

function Sync(): null {
  useTranscriptionConsentSync();
  return null;
}

/** The Settings row and the layout's sync, mounted together as in the app. */
function SettingsWithSync(): ReactElement {
  return createElement("div", null, createElement(Sync), createElement(CloudTranscriptionSettings));
}

describe("a Turn off the account has not heard yet", () => {
  test("a yes from the account, refreshed after a failed withdrawal, does not switch this device back on", async () => {
    mockAnswer = ON;
    mockMutationFails = true;
    const view = mount(createElement(SettingsWithSync));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(true);

    press("cloud-transcription-turn-off");
    await settle();
    expect(shown("cloud-transcription-unsaved")).toBe(true);

    // A reconnect: the account still says yes, as a fresh answer.
    mockAnswer = { ...ON };
    view.rerender(createElement(SettingsWithSync));
    await settle();

    expect(cloudTranscriptionAllowed()).toBe(false);
    view.unmount();
  });

  test("once the account is seen saying no, a later yes from the account counts again", async () => {
    mockAnswer = ON;
    mockMutationFails = true;
    const view = mount(createElement(SettingsWithSync));
    press("cloud-transcription-turn-off");
    await settle();
    mockMutationFails = false;

    // The account's no confirms the withdrawal; a yes after it (Allow pressed
    // on another device) is honoured.
    mockAnswer = { ...OFF };
    view.rerender(createElement(SettingsWithSync));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(false);

    mockAnswer = { ...ON };
    view.rerender(createElement(SettingsWithSync));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(true);
    view.unmount();
  });
});

describe("the account's answer on this device", () => {
  test("loading is no", () => {
    setTranscriptionConsent(V);
    mockAnswer = undefined;
    const { unmount } = mount(createElement(Sync));
    expect(cloudTranscriptionAllowed()).toBe(false);
    unmount();
  });

  test("signed out is no", () => {
    setTranscriptionConsent(V);
    mockAnswer = null;
    const { unmount } = mount(createElement(Sync));
    expect(cloudTranscriptionAllowed()).toBe(false);
    unmount();
  });

  test("a current yes is yes, once this device has checked it holds no Turn off, and unmounting forgets it", async () => {
    mockAnswer = ON;
    const { unmount } = mount(createElement(Sync));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(true);
    unmount();
    expect(cloudTranscriptionAllowed()).toBe(false);
  });

  test("a no from the account empties the spool", () => {
    mockAnswer = ON;
    const view = mount(createElement(Sync));
    expect(mockForget).not.toHaveBeenCalled();

    mockAnswer = { ...OFF };
    view.rerender(createElement(Sync));

    expect(cloudTranscriptionAllowed()).toBe(false);
    expect(mockForget).toHaveBeenCalled();
    view.unmount();
  });

  test("a yes to an older disclosure is no", () => {
    mockAnswer = OLD;
    const { unmount } = mount(createElement(Sync));
    expect(cloudTranscriptionAllowed()).toBe(false);
    unmount();
  });
});

describe("a Turn off the account has not heard yet, across a restart", () => {
  async function turnOffWhileOffline(): Promise<void> {
    mockAnswer = ON;
    mockMutationFails = true;
    const view = mount(createElement(SettingsWithSync));
    await settle();
    press("cloud-transcription-turn-off");
    await settle();
    view.unmount();
  }

  test("after a restart the account's yes still does not switch this device on, and the Turn off is sent again", async () => {
    await turnOffWhileOffline();
    restart();
    mockMutations.length = 0;
    mockMutationFails = false;

    mockAnswer = { ...ON };
    const view = mount(createElement(Sync));
    await settle();

    expect(cloudTranscriptionAllowed()).toBe(false);
    expect(mockMutations).toEqual(["functions/transcriptionConsent:withdrawTranscription"]);
    view.unmount();
  });

  test("another account's no does not clear it", async () => {
    await turnOffWhileOffline();
    restart();

    mockAnswer = { ...OFF, account: "user_two" };
    const other = mount(createElement(Sync));
    await settle();
    other.unmount();

    mockAnswer = { ...ON };
    const view = mount(createElement(Sync));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(false);
    view.unmount();
  });

  test("once its own account says no, it is cleared, and a later yes counts", async () => {
    await turnOffWhileOffline();
    restart();

    mockAnswer = { ...OFF };
    const view = mount(createElement(Sync));
    await settle();
    expect(await device.keys()).toEqual([]);

    mockAnswer = { ...ON };
    view.rerender(createElement(Sync));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(true);
    view.unmount();
  });
});

function NewMeeting(): ReactElement {
  const consent = useTranscriptionConsentGate({ capture: { audio: true, transcribesAt: "cloud" } });
  return createElement(
    "div",
    null,
    createElement("button", { "data-testid": "start", onClick: () => consent.gate(() => {}) }, "+"),
    consent.sheet,
  );
}

describe("a store that cannot be read holds the device off", () => {
  test("a kept Turn off that cannot be read: the account's yes is not used and nothing is resent", async () => {
    await (async () => {
      mockAnswer = ON;
      mockMutationFails = true;
      const view = mount(createElement(SettingsWithSync));
      await settle();
      press("cloud-transcription-turn-off");
      await settle();
      view.unmount();
    })();
    // A restart into a store that throws on every read.
    setWithdrawalStore({
      get: async () => {
        throw new Error("storage unavailable");
      },
      set: device.set,
      remove: device.remove,
    });
    transcriptionWithdrawalConfirmed();
    setTranscriptionConsent(null);
    mockMutations.length = 0;
    mockMutationFails = false;

    mockAnswer = { ...ON };
    const view = mount(createElement("div", null, createElement(Sync), createElement(NewMeeting)));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(false);
    expect(mockMutations).toEqual([]);

    // Read again on the next answer, and still held off.
    mockAnswer = { ...ON };
    view.rerender(createElement("div", null, createElement(Sync), createElement(NewMeeting)));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(false);

    // Allow pressed here lifts it for this run.
    press("start");
    await settle();
    press("transcription-consent-allow");
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(true);
    view.unmount();
  });
});

describe("Allow pressed here lifts a kept Turn off", () => {
  test("Allow from a New meeting clears it for the signed-in account, so the account's yes counts again", async () => {
    await (async () => {
      mockAnswer = ON;
      mockMutationFails = true;
      const view = mount(createElement(SettingsWithSync));
      await settle();
      press("cloud-transcription-turn-off");
      await settle();
      view.unmount();
    })();
    restart();
    mockMutationFails = false;

    mockAnswer = { ...ON };
    const view = mount(createElement("div", null, createElement(Sync), createElement(NewMeeting)));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(false);

    press("start");
    await settle();
    press("transcription-consent-allow");
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(true);
    expect(await device.keys()).toEqual([]);

    // The account's next answer (the same yes) keeps it on.
    mockAnswer = { ...ON };
    view.rerender(createElement("div", null, createElement(Sync), createElement(NewMeeting)));
    await settle();
    expect(cloudTranscriptionAllowed()).toBe(true);
    view.unmount();
  });
});
