import { describe, expect, test } from "@jest/globals";
import {
  base64Utf8,
  CLIENT_PROVIDERS,
  cursorInstallHref,
  fieldsCaption,
  SERVER_DESCRIPTION,
  SERVER_NAME,
  SERVER_SLUG,
  shellQuote,
  vsCodeInstallHref,
} from "../features/console/clients/providers";
import { isAppScheme } from "../features/console/clients/openScheme";
import { isSafeRedirect } from "../features/consent/redirectSafety";

/**
 * The connect catalogue.
 *
 * Most of what could go wrong here is not a crash — it is a link that quietly
 * points at the wrong place, which nobody notices until somebody's client is
 * talking to a gateway they did not choose. So these tests are about the two
 * properties that cannot be checked by looking:
 *
 *  1. **Every built URL comes from the endpoint the caller passed.** A deep
 *     link that hard-coded `mcp.context.lc` would work perfectly in our console
 *     and connect a self-hoster's editor to our deployment.
 *  2. **What a row says matches what its button does.** The caption under the
 *     fields is derived, not written per row, because the first version of it
 *     was derived from the wrong thing and told Notion users to run a URL in
 *     their terminal.
 */

/** Deliberately not our host, and deliberately not the default port. */
const SELF_HOSTED = "https://mcp.example.test:8443/mcp";

describe("the catalogue", () => {
  test("the clients people actually asked for are all in it", () => {
    const ids = CLIENT_PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "chatgpt",
        "claude",
        "claude-code",
        "codex",
        "cursor",
        "vscode",
        "notion",
        "gemini-cli",
      ]),
    );
  });

  test("ids are unique, so the open-row state cannot address two rows", () => {
    const ids = CLIENT_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("field ids are unique within a provider, so React keys are stable", () => {
    for (const provider of CLIENT_PROVIDERS) {
      const ids = provider.fields(SELF_HOSTED).map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("every provider offers something to copy and somewhere to go", () => {
    for (const provider of CLIENT_PROVIDERS) {
      expect(provider.fields(SELF_HOSTED).length).toBeGreaterThan(0);
      expect(provider.link(SELF_HOSTED).href).toMatch(/^[a-z]+:/);
      expect(provider.link(SELF_HOSTED).label.length).toBeGreaterThan(0);
      expect(provider.note.length).toBeGreaterThan(0);
    }
  });
});

describe("no link outlives the endpoint it was built from", () => {
  /**
   * The whole point. `context.lc` must not appear in anything built for a
   * self-hoster — not in a deep link's payload, not in a command, not in a
   * field value.
   */
  test("nothing built from a self-hosted endpoint mentions our deployment", () => {
    for (const provider of CLIENT_PROVIDERS) {
      const href = provider.link(SELF_HOSTED).href;
      const decoded = decodeURIComponent(href);
      const payload = /config=([^&]+)/.exec(decoded)?.[1];

      expect(href).not.toContain("context.lc");
      expect(payload === undefined ? "" : decodeBase64Loose(payload)).not.toContain("context.lc");

      for (const field of provider.fields(SELF_HOSTED)) {
        expect(field.value).not.toContain("context.lc");
      }
    }
  });

  test("every provider that shows a URL shows the one it was given", () => {
    for (const provider of CLIENT_PROVIDERS) {
      const values = provider.fields(SELF_HOSTED).map((f) => f.value);
      // Either a bare URL field, or a command with the URL in it.
      expect(values.some((v) => v.includes(SELF_HOSTED))).toBe(true);
    }
  });
});

describe("deep links", () => {
  test("Cursor gets its documented shape, with the config base64'd", () => {
    const href = cursorInstallHref(SELF_HOSTED);
    expect(href.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?")).toBe(true);
    expect(href).toContain(`name=${SERVER_SLUG}`);

    const config = decodeURIComponent(/config=([^&]+)/.exec(href)![1]);
    expect(JSON.parse(decodeBase64Loose(config))).toEqual({ url: SELF_HOSTED });
  });

  test("VS Code gets an https redirect carrying url-encoded JSON", () => {
    const href = vsCodeInstallHref(SELF_HOSTED);
    expect(href.startsWith("https://insiders.vscode.dev/redirect/mcp/install?")).toBe(true);

    const config = decodeURIComponent(/config=([^&]+)/.exec(href)![1]);
    expect(JSON.parse(config)).toEqual({ type: "http", url: SELF_HOSTED });
  });

  /**
   * A config containing a raw `&` or `#` would truncate the query string and
   * hand the client half a URL. Both builders encode; this proves it rather
   * than trusting it.
   */
  test("a config is escaped, not pasted in raw", () => {
    const awkward = "https://host.test/mcp?a=1&b=2#frag";
    for (const href of [cursorInstallHref(awkward), vsCodeInstallHref(awkward)]) {
      const query = href.slice(href.indexOf("?") + 1);
      expect(query.split("&")).toHaveLength(2);
      expect(query).not.toContain("#");
    }
  });
});

describe("base64Utf8", () => {
  test("matches the reference encoder, padding included", () => {
    for (const input of ["", "a", "ab", "abc", "abcd", '{"url":"https://x.test/mcp"}']) {
      expect(base64Utf8(input)).toBe(Buffer.from(input, "utf8").toString("base64"));
    }
  });

  test("encodes non-ASCII as UTF-8 rather than mangling it", () => {
    const input = '{"url":"https://exämple.test/mcp"}';
    expect(base64Utf8(input)).toBe(Buffer.from(input, "utf8").toString("base64"));
  });
});

describe("fieldsCaption", () => {
  /**
   * The bug this exists for: Notion's link is `docs` because Notion has no
   * deep link to its connector screen — but the fields are still a Name and a
   * URL for a form. A caption keyed on the link kind alone said "Run these in
   * your terminal."
   */
  test("a form is never described as a terminal command", () => {
    const notion = CLIENT_PROVIDERS.find((p) => p.id === "notion")!;
    expect(notion.link("x:").kind).toBe("docs");
    expect(fieldsCaption(notion, "docs")).not.toMatch(/terminal/i);
  });

  test("a command is described as a command whatever the link does", () => {
    const codex = CLIENT_PROVIDERS.find((p) => p.id === "codex")!;
    expect(fieldsCaption(codex, "docs")).toMatch(/terminal/i);
    expect(fieldsCaption(codex, "connector")).toMatch(/terminal/i);
  });

  test("a one-click install does not tell people to paste anything", () => {
    const cursor = CLIENT_PROVIDERS.find((p) => p.id === "cursor")!;
    expect(cursor.link(SELF_HOSTED).kind).toBe("install");
    expect(fieldsCaption(cursor, "install")).toMatch(/nothing to paste/i);
  });
});

describe("the strings people paste", () => {
  test("the name and description are the same everywhere they appear", () => {
    for (const provider of CLIENT_PROVIDERS.filter((p) => p.form === "connector")) {
      const fields = provider.fields(SELF_HOSTED);
      expect(fields.find((f) => f.id === "name")?.value).toBe(SERVER_NAME);
      const description = fields.find((f) => f.id === "description");
      if (description !== undefined) expect(description.value).toBe(SERVER_DESCRIPTION);
    }
  });

  test("a description is always marked optional — no client requires one", () => {
    for (const provider of CLIENT_PROVIDERS) {
      const description = provider.fields(SELF_HOSTED).find((f) => f.id === "description");
      if (description !== undefined) expect(description.optional).toBe(true);
    }
  });

  /**
   * The product noun is "context", never "brain" — CLAUDE.md, Vocabulary. This
   * is the copy an AI client stores and shows back to the person, so it is the
   * copy most likely to outlive a rename.
   */
  test("nothing on offer calls the product a brain", () => {
    for (const provider of CLIENT_PROVIDERS) {
      expect(provider.note.toLowerCase()).not.toContain("brain");
      for (const field of provider.fields(SELF_HOSTED)) {
        expect(field.value.toLowerCase()).not.toContain("brain");
      }
    }
  });
});

describe("opening a link", () => {
  test("app schemes are recognised, http is not", () => {
    expect(isAppScheme("cursor://anysphere.cursor-deeplink/mcp/install")).toBe(true);
    expect(isAppScheme("vscode:mcp/install")).toBe(true);
    expect(isAppScheme("https://claude.ai/customize/connectors")).toBe(false);
    expect(isAppScheme("http://localhost:3000")).toBe(false);
    expect(isAppScheme("/relative/path")).toBe(false);
  });

  /**
   * `isAppScheme` says yes to `javascript:`, because it is a scheme and it is
   * not http — and the web opener hands app schemes to `location.assign`. What
   * stops that being script execution is `isSafeRedirect`, the consent screen's
   * rule, reused rather than reimplemented: this module had its own copy and
   * the copy was weaker (no `vbscript:`, no `about:`, no parse).
   */
  test("script-bearing schemes are refused by the shared rule", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "about:blank",
      "file:///etc/passwd",
      "blob:https://evil.test/x",
      "not-a-url",
    ]) {
      expect(isSafeRedirect(href)).toBe(false);
    }
  });

  test("every link in the catalogue passes the safety check", () => {
    for (const provider of CLIENT_PROVIDERS) {
      expect(isSafeRedirect(provider.link(SELF_HOSTED).href)).toBe(true);
    }
  });
});

describe("commands are safe to paste", () => {
  /**
   * The deep links were escaped from the start and the commands were not. An
   * endpoint carrying `&` truncates the command at the ampersand: the URL is
   * silently mangled, `b=2` runs as an assignment, and the person ends up with
   * a server configured to talk to half an address.
   */
  test("an endpoint needing quotes gets them, in every command", () => {
    const awkward = "https://host.test/mcp?a=1&b=2";
    for (const provider of CLIENT_PROVIDERS.filter((p) => p.form === "command")) {
      for (const field of provider.fields(awkward)) {
        if (!field.value.includes("host.test")) continue;
        expect(field.value).toContain(`'${awkward}'`);
      }
    }
  });

  /**
   * And an ordinary endpoint does not, because quotes on every row are noise
   * that teaches people to skip the row where quoting is load-bearing.
   */
  test("an ordinary endpoint is left bare", () => {
    for (const provider of CLIENT_PROVIDERS.filter((p) => p.form === "command")) {
      for (const field of provider.fields(SELF_HOSTED)) {
        expect(field.value).not.toContain("'");
      }
    }
  });

  test("shellQuote handles the quote character itself", () => {
    expect(shellQuote("https://ok.test/mcp")).toBe("https://ok.test/mcp");
    expect(shellQuote("https://host/a b")).toBe("'https://host/a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("a;rm -rf /")).toBe("'a;rm -rf /'");
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
  });
});

/** Base64 decode without assuming a browser global. */
function decodeBase64Loose(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}
