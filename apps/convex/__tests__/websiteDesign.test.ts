/**
 * A site's design, end to end through the public resolver: code notes are
 * published by Publish like pages, drawn from the release, narrowed at once by
 * `privacy.md`, sanitized before they leave, never addresses of their own, and
 * drawn only on a plan that has designs.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, pressPublish, publish, type Fixture } from "./website.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const IMAGES = ".context/assets/images/";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

const FRAME = [
  "The frame around every page.",
  "",
  "```html",
  '<header><nav>{ each item in site.nav }<a href="{ item.link }">{ item.title }</a>{ end }</nav>',
  '<a href="/" class="logo"><img src="supa-logo.png" alt="Supa"></a></header>',
  "<main>{ content }</main>",
  "<script>alert(1)</script>",
  "```",
].join("\n");
const CARDS = [
  "```html",
  '<div class="cards">{ each card in page.sections }<a class="card" href="{ card.link }"><h2>{ card.heading }</h2></a>{ end }</div>',
  "```",
].join("\n");
const STYLES = (accent: string) =>
  ["```css", `:root { --accent: ${accent}; }`, ".logo:hover img { transform: rotate(360deg); }", "body { background: url(https://evil.test/x.png); }", "```"].join("\n");

async function supa(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed(`${IMAGES}supa-logo.png`, PNG);
  f.backend.seed("website/index.md", "---\ntitle: Supa\nnav: 0\n---\n\n# Super smart people\n");
  f.backend.seed(
    "website/code.md",
    "---\ntitle: Code\nnav: 1\nlayout: cards\n---\n\n# Code\n\n## Supa Radio\n\n[Open](https://radio.supa.test)\n",
  );
  f.backend.seed("website/layout.html.md", FRAME);
  f.backend.seed("website/cards.html.md", CARDS);
  f.backend.seed("website/styles.css.md", STYLES("#FFD23F"));
  f.backend.seed("website/pricing.html.md", "Notes for agents: keep prices in sync.\n\n```html\n<h1>Pricing</h1><p>$5</p>\n```\n");
  await publish(f);
  return f;
}

const resolve = (f: Fixture, routePath: string) =>
  f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath });

describe("website designs", () => {
  test("a page is drawn with the frame, the layout it names and the site's stylesheets, sanitized", async () => {
    const f = await supa();
    const page = await resolve(f, "/code");
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;
    expect(page.markdown).toBe("# Code\n\n## Supa Radio\n\n[Open](https://radio.supa.test)\n");
    expect(page.design).toBeDefined();
    const design = page.design!;
    expect(design.frame).toContain("<main>{ content }</main>");
    expect(design.frame).toContain('{ each item in site.nav }<a href="{ item.link }">');
    expect(design.frame).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="Supa">/);
    expect(design.frame).not.toContain("script");
    expect(design.template).toContain('<div class="cards">');
    expect(design.css).toContain(".ctx-site { --accent: #FFD23F; }");
    expect(design.css).toContain(".ctx-site .logo:hover img { transform: rotate(360deg); }");
    expect(design.css).not.toContain("evil.test");
  });

  test("a page that names no layout gets the frame and stylesheets only", async () => {
    const f = await supa();
    const page = await resolve(f, "/");
    expect(page).toMatchObject({ kind: "page", design: { template: null } });
  });

  test("code notes are never addresses", async () => {
    const f = await supa();
    for (const path of ["/layout", "/layout.html", "/cards", "/styles", "/styles.css"]) {
      expect((await resolve(f, path)).kind).toBe("unavailable");
    }
    const page = await resolve(f, "/");
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.navigation.map((item) => item.routePath)).toEqual(["/", "/code"]);
  });

  test("an .html.md page is served as its HTML, and its prose stays notes", async () => {
    const f = await supa();
    const page = await resolve(f, "/pricing");
    expect(page).toMatchObject({ kind: "page", markdown: "", design: { template: "<h1>Pricing</h1><p>$5</p>" } });
    expect(JSON.stringify(page)).not.toContain("Notes for agents");
  });

  test("saving a stylesheet changes nothing a visitor sees until Publish", async () => {
    const f = await supa();
    f.backend.seed("website/styles.css.md", STYLES("#00FF00"));
    await asUser(f.t, f.owner).action(api.functions.websites.refreshRouteStatuses, { workspaceId: f.workspaceId });
    const before = await resolve(f, "/");
    if (before.kind !== "page") throw new Error("expected a page");
    expect(before.design!.css).toContain("#FFD23F");
    expect(before.design!.css).not.toContain("#00FF00");

    await expect(pressPublish(f)).resolves.toMatchObject({ published: true });
    const after = await resolve(f, "/");
    if (after.kind !== "page") throw new Error("expected a page");
    expect(after.design!.css).toContain("#00FF00");
  });

  test("a stylesheet privacy.md holds back is gone at once, without a Publish", async () => {
    const f = await supa();
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "website/styles.css.md",
      visibility: "private",
    });
    const page = await resolve(f, "/");
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.design?.css ?? "").not.toContain("--accent");
  });

  test("a members-only stylesheet is drawn for members only", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\n# Hi\n");
    f.backend.seed("website/team.css.md", "---\naudience: members\n---\n\n```css\n.secret { color: red; }\n```\n");
    await publish(f);
    const anonymous = await resolve(f, "/");
    expect(anonymous).toMatchObject({ kind: "page" });
    expect(JSON.stringify(anonymous)).not.toContain("secret");
    const member = await asUser(f.t, f.member).action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/" });
    expect(member).toMatchObject({ kind: "page", design: { css: ".ctx-site .secret { color: red; }" } });
  });

  test("a broken code note stops Publish and names itself", async () => {
    const f = await supa();
    f.backend.seed("website/layout.html.md", "```html\n<main></main>\n```\n");
    await expect(pressPublish(f)).resolves.toEqual({
      published: false,
      problems: [{ path: "website/layout.html.md", message: "layout.html.md needs { content } where each page goes." }],
    });
  });

  test("the edge copy signed-out visitors are served carries the design", async () => {
    const f = await supa();
    const answer = await f.t.fetch("/site/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "atlas", routePath: "/code" }),
    });
    const body = (await answer.json()) as { address: { design?: { template: string | null; css: string } } };
    expect(body.address.design?.template).toContain('<div class="cards">');
    expect(body.address.design?.css).toContain("--accent: #FFD23F");
    // And an all-HTML page, whose design is the whole page.
    const pricing = await f.t.fetch("/site/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "atlas", routePath: "/pricing" }),
    });
    expect(((await pricing.json()) as { address: { design?: { template: string } } }).address.design?.template).toBe(
      "<h1>Pricing</h1><p>$5</p>",
    );
  });

  test("a site with no code notes looks exactly as it did", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\n# Hi\n");
    await publish(f);
    const page = await resolve(f, "/");
    expect(page).toMatchObject({ kind: "page", markdown: "# Hi\n" });
    expect(page).not.toHaveProperty("design");
  });

  describe("designs are Premium", () => {
    test("on a deployment that sells, a plan that is not paying gets the default look and no HTML pages", async () => {
      vi.stubEnv("STRIPE_PRICE_ID", "price_FAKE00000000000000000000");
      const f = await supa();
      const page = await resolve(f, "/code");
      expect(page).toMatchObject({ kind: "page" });
      expect(page).not.toHaveProperty("design");
      expect((await resolve(f, "/pricing")).kind).toBe("unavailable");

      await f.t.run(async (ctx) => {
        await ctx.db.insert("workspacePlans", {
          workspaceId: f.workspaceId,
          managedStorage: false,
          fastSearch: true,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });
      expect(await resolve(f, "/code")).toHaveProperty("design");
      expect((await resolve(f, "/pricing")).kind).toBe("page");
    });
  });
});
