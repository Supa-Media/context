/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of the sign-in and account-setup screens, for the design audit
 * (`docs/decisions/app-and-console.md`). Same technique as `share-sheet-shots.ts`:
 * the shipped components, rendered by react-dom into a real DOM, written out as
 * self-contained `.html`, and photographed by Playwright.
 *
 * The hooks these screens use (Convex queries, mutations and actions, the auth
 * provider, the router and the safe-area insets) are mocked so they answer fixed,
 * fake data. Every value is invented: a test workspace, a test slug, test
 * addresses under reserved domains. Long strings are deliberate, to test overflow.
 *
 *     pnpm exec jest --testMatch '**\/scripts/account-setup-shots.ts' --testPathIgnorePatterns '[]'
 *
 * The HTML and the photo step land in `ACCOUNT_SETUP_SHOTS_DIR` (default below).
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(
  process.env.ACCOUNT_SETUP_SHOTS_DIR ??
    "/tmp/claude-0/-home-user/bf86cd4f-a947-5a2a-a4c0-08b1d56a8f83/scratchpad/account-setup-shots",
);

/* -------------------------------------------------------------------------- */
/* Fake data. Everything here is invented.                                     */
/* -------------------------------------------------------------------------- */

const WORK_EMAIL = "alex.long-name-for-testing@publicworship.life";
const SUGGESTED_NAME = "Alexandra Montgomery-Fitzwilliam Okonkwo-Brathwaite de la Cruz Nakamura";
const PERSONAL_EMAIL = "alexandra.montgomery-fitzwilliam.okonkwo@long-personal-mail-for-testing.example";
const SHARED_NEXT = "/console/@public-worship?note=artists%2Fartist-role.md";
const E164 = "+15550100199";

type Fake = {
  next: string;
  phoneCheck: { confirmed: boolean; phone?: string } | undefined;
  sendPhone: (args: { phone: string }) => Promise<unknown>;
  checkPhone: (args: { phone: string; code: string }) => Promise<unknown>;
  sendEmail: (args: { email: string }) => Promise<unknown>;
  checkEmail: (args: { code: string }) => Promise<unknown>;
  finish: (args: { name: string }) => Promise<unknown>;
};

/** Reset before every board, so no state leaks from one picture to the next. */
const fakeDefaults = (): Fake => ({
  next: SHARED_NEXT,
  phoneCheck: { confirmed: false },
  sendPhone: async () => ({ status: "sent", phone: E164 }),
  checkPhone: async () => ({ status: "confirmed" }),
  sendEmail: async ({ email }) => ({ status: "sent", email }),
  checkEmail: async () => ({ status: "added" }),
  finish: async () => ({}),
});

/*
  Named `mockFake` because Jest hoists `jest.mock` above every declaration and
  refuses a factory that closes over an ordinary local. The factories only read
  it when React calls the hook, so the late initialisation is safe.
*/
const mockFake: Fake = fakeDefaults();

/* -------------------------------------------------------------------------- */
/* Mocks: every hook the two screens reach, answering fake data.               */
/* -------------------------------------------------------------------------- */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
  useLocalSearchParams: () => ({ next: mockFake.next }),
  usePathname: () => "/",
  Redirect: () => null,
  Slot: () => null,
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signIn: async () => ({}),
    signOut: async () => {},
  }),
}));

jest.mock("convex/react", () => {
  const fnName = (ref: unknown): string => {
    const { getFunctionName } = require("convex/server") as typeof import("convex/server");
    try {
      return getFunctionName(ref as never);
    } catch {
      return String(ref);
    }
  };
  return {
    useQuery: (ref: unknown) => (fnName(ref).endsWith("myPhoneCheck") ? mockFake.phoneCheck : undefined),
    useMutation: (ref: unknown) => {
      const name = fnName(ref);
      if (name.endsWith("finishSetup")) return (args: { name: string }) => mockFake.finish(args);
      return async () => ({});
    },
    useAction: (ref: unknown) => {
      const name = fnName(ref);
      if (name.endsWith("sendPhoneCode")) return (args: { phone: string }) => mockFake.sendPhone(args);
      if (name.endsWith("confirmPhoneCode")) {
        return (args: { phone: string; code: string }) => mockFake.checkPhone(args);
      }
      if (name.endsWith("startAddEmail")) return (args: { email: string }) => mockFake.sendEmail(args);
      if (name.endsWith("confirmAddEmail")) return (args: { code: string }) => mockFake.checkEmail(args);
      return async () => ({});
    },
  };
});

/* -------------------------------------------------------------------------- */
/* Rendering and writing.                                                      */
/* -------------------------------------------------------------------------- */

const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { AccountSetupScreen } = require("../features/auth/AccountSetupScreen") as typeof import("../features/auth/AccountSetupScreen");
const { AccountSetupJoined } = require("../features/auth/AccountSetupJoined") as typeof import("../features/auth/AccountSetupJoined");
const { LoginScreen } = require("../features/auth/LoginScreen") as typeof import("../features/auth/LoginScreen");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

function stampViewport(width: number, height: number): void {
  for (const [key, value] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    Object.defineProperty(document.documentElement, key, { value, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

async function mount(node: ReactElement, width: number, height: number): Promise<void> {
  stampViewport(width, height);
  container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme: "light", children: node }));
  });
}

const byId = (testID: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

/** A click the way a pointer delivers one; react-native-web reacts to these. */
async function press(testID: string): Promise<void> {
  const node = byId(testID);
  if (node === null) throw new Error(`nothing to press: ${testID}`);
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

/** Types into a field the way the keyboard does: a real input event, then the flush. */
async function typeInto(testID: string, value: string): Promise<void> {
  const node = byId(testID);
  if (node === null) throw new Error(`nothing to type into: ${testID}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(node as HTMLInputElement, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function page(title: string, body: string, css: string, width: number, height: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

/** Writes the mounted screen as a self-contained page at one viewport. */
function write(name: string, width: number, height: number): void {
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  expect(container).not.toBeNull();
  writeFileSync(file, page(name, container!.innerHTML, css, width, height));
}

/** One board at both widths: reset the fakes, mount, run the steps, write. */
async function board(
  name: string,
  node: () => ReactElement,
  steps: () => Promise<void>,
  fake: Partial<Fake> = {},
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    Object.assign(mockFake, fakeDefaults(), fake);
    await mount(node(), viewport.width, viewport.height);
    await steps();
    write(`${name}-${viewport.name}`, viewport.width, viewport.height);
    await act(async () => root!.unmount());
    container!.remove();
    root = null;
    container = null;
  }
}

const nothing = async () => {};

const setup = (overrides: Partial<Record<"email" | "name", string>> = {}) => ({
  email: overrides.email ?? WORK_EMAIL,
  suggestedName: overrides.name ?? SUGGESTED_NAME,
});

/* -------------------------------------------------------------------------- */
/* The boards.                                                                 */
/* -------------------------------------------------------------------------- */

describe("account setup and shared-note sign-in shots", () => {
  test("account setup: the first step, name and phone", async () => {
    await board(
      "01-account-setup-first-step",
      () => createElement(AccountSetupScreen, setup()),
      nothing,
      { phoneCheck: { confirmed: false } },
    );
  }, 120_000);

  test("account setup: the phone code is sent", async () => {
    await board(
      "02-account-setup-phone-code",
      () => createElement(AccountSetupScreen, setup()),
      async () => {
        await typeInto("account-setup-phone", "5550100199");
        await press("account-setup-phone-send");
      },
      { phoneCheck: { confirmed: false } },
    );
  }, 120_000);

  test("account setup: phone done, personal email code sent", async () => {
    await board(
      "03-account-setup-personal-email",
      () => createElement(AccountSetupScreen, setup()),
      async () => {
        await typeInto("account-setup-email", PERSONAL_EMAIL);
        await press("account-setup-email-send");
      },
      { phoneCheck: { confirmed: true, phone: E164 } },
    );
  }, 120_000);

  test("account setup: everything in, Continue offered", async () => {
    await board(
      "04-account-setup-ready",
      () => createElement(AccountSetupScreen, setup()),
      async () => {
        await typeInto("account-setup-email", PERSONAL_EMAIL);
        await press("account-setup-email-send");
        await typeInto("account-setup-email-code", "482913");
      },
      { phoneCheck: { confirmed: true, phone: E164 } },
    );
  }, 120_000);

  test("account setup: a number that already has an account joins it", async () => {
    await board(
      "05-account-setup-joined",
      () => createElement(AccountSetupScreen, setup()),
      async () => {
        await typeInto("account-setup-phone", "5550100199");
        await press("account-setup-phone-send");
        await typeInto("account-setup-phone-code", "482913");
      },
      {
        phoneCheck: { confirmed: false },
        checkPhone: async () => ({ status: "joined" }),
      },
    );
  }, 120_000);

  test("account setup: the joined notice, drawn on its own", async () => {
    for (const viewport of VIEWPORTS) {
      Object.assign(mockFake, fakeDefaults());
      await mount(createElement(AccountSetupJoined), viewport.width, viewport.height);
      write(`06-account-setup-joined-notice-${viewport.name}`, viewport.width, viewport.height);
      await act(async () => root!.unmount());
      container!.remove();
      root = null;
      container = null;
    }
  }, 120_000);

  test("sign-in for a shared note, before typing", async () => {
    await board("07-shared-note-sign-in", () => createElement(LoginScreen), nothing);
  }, 120_000);

  test("sign-in for a shared note, with a long work email typed", async () => {
    await board(
      "08-shared-note-sign-in-typed",
      () => createElement(LoginScreen),
      async () => {
        await typeInto("login-email", WORK_EMAIL);
      },
    );
  }, 120_000);
});
