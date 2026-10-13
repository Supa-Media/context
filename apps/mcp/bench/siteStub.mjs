/**
 * A WEBSITE AND A DOMAIN FOR THE BENCHMARK'S INVENTED PEOPLE.
 *
 * Tex sets up a person's website and connects their domain (the owner's ask,
 * 2026-10-13), through `write_note` `site`. In production the control plane
 * answers that (`apps/convex/functions/lib/websites/agentSite.ts`); in a run
 * this does, in the same shapes, from the invented workspace's own bucket, so
 * a task is judged on what Tex actually wrote, checked, published and
 * connected. Nothing here decides who may: the stub control plane has already
 * cleared an owner or editor (`controlPlaneStub`), and only an owner connects
 * a domain, as in production.
 *
 * What it did is recorded beside the scripted browser's events, so a task can
 * check it without a judge (`checks.mjs`): `publish`, and `connect <hostname>`.
 *
 * Every site is on (a person who asks for a site in a run has one turned on)
 * and every workspace pays; the off and unpaid cases are the control plane's
 * own suite's to prove.
 */

const APP = "https://app.bench.invalid";
const TARGET = "customers.context.lc";
const CODE = /\.(html|css)\.md$/;

function addressOf(path) {
  const rest = path.slice("website/".length).replace(/\.md$/, "");
  if (rest === "index") return "/";
  return `/${rest.replace(/\/index$/, "")}`;
}

function hex(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * @param {{ bucketOf: (workspaceId: string) => Map<string, {body: string, etag: string}> | null,
 *           handleOf: (workspaceId: string) => string | null }} world
 */
export function createBenchSite({ bucketOf, handleOf }) {
  const events = [];
  /** workspaceId → { revision, published: Map<path, etag>, domain } */
  const sites = new Map();
  const siteOf = (id) => {
    if (!sites.has(id)) sites.set(id, { revision: 0, published: new Map(), domain: null });
    return sites.get(id);
  };

  function pages(id) {
    const bucket = bucketOf(id);
    if (!bucket) return [];
    return [...bucket.entries()]
      .filter(([key]) => key.startsWith("website/") && key.endsWith(".md"))
      .map(([key, value]) => ({ path: key, etag: value.etag, body: value.body }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  const draftOf = (list) => (hex(list.map((page) => `${page.path}\n${page.etag}`).join("\n\n")) + hex(String(list.length))).slice(0, 16);

  function addresses(id) {
    const handle = handleOf(id);
    const site = siteOf(id);
    return [
      `${APP}/@${handle}`,
      `https://${handle}.ctxlc.site`,
      ...(site.domain?.live ? [`https://${site.domain.hostname}`] : []),
    ];
  }

  function status(id) {
    const site = siteOf(id);
    const handle = handleOf(id);
    const list = pages(id);
    return {
      enabled: true,
      handle,
      settingsUrl: `${APP}/console/@${handle}?settings=website`,
      draft: draftOf(list),
      publishedRevision: site.revision === 0 ? null : site.revision,
      publishedAt: null,
      addresses: addresses(id),
      pages: list.map((page) => {
        const draft = /^---[\s\S]*?\ndraft:\s*true\b[\s\S]*?\n---/.test(page.body);
        return {
          path: page.path,
          address: CODE.test(page.path) ? null : addressOf(page.path),
          editUrl: `${APP}/note/@${handle}/${page.path.split("/").map(encodeURIComponent).join("/")}`,
          status: draft ? "draft" : "live",
          audience: "public",
          role: CODE.test(page.path) ? "code" : null,
          changed: site.published.get(page.path) !== page.etag,
          problems: [],
        };
      }),
      removed: [...site.published.keys()]
        .filter((path) => !list.some((page) => page.path === path))
        .map((path) => ({ path, address: addressOf(path) })),
    };
  }

  function domainView(id, owner) {
    const domain = siteOf(id).domain;
    if (domain === null) return null;
    const records = [
      { purpose: "routing", type: domain.apex ? "ALIAS" : "CNAME", name: domain.hostname, host: domain.apex ? "@" : domain.hostname.split(".")[0], value: TARGET, done: domain.live },
      { purpose: "ownership", type: "TXT", name: `_context.${domain.hostname}`, host: domain.apex ? "_context" : `_context.${domain.hostname.split(".")[0]}`, value: `context-verification=${hex(domain.hostname)}${hex(id)}`, done: domain.live },
    ];
    return {
      id: `dom_${hex(domain.hostname)}`,
      hostname: domain.hostname,
      apex: domain.apex,
      status: domain.live ? "active" : "pending",
      stage: domain.live ? "live" : "ownership",
      ownershipVerified: domain.live,
      routingVerified: domain.live,
      httpsReady: domain.live,
      problem: null,
      homeSlug: null,
      checkedAt: null,
      checkingSince: 0,
      records: owner ? records : [],
      oneClick: null,
      www: domain.apex ? { hostname: `www.${domain.hostname}`, live: domain.live, stage: domain.live ? "live" : "ownership", problem: null } : null,
    };
  }

  function domain(id, owner, hostname) {
    const site = siteOf(id);
    let message;
    if (hostname !== undefined) {
      const name = String(hostname).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
      if (!owner) message = "Only the workspace's owner can connect a domain.";
      else if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) message = "That isn't a domain name.";
      else if (site.domain !== null && site.domain.hostname !== name) {
        message = `This workspace already has ${site.domain.hostname}. Its owner removes it in Settings › Website before connecting a different one.`;
      } else if (site.domain === null) {
        site.domain = { hostname: name, apex: name.split(".").length === 2, live: false };
        events.push(`connect ${name}`);
      }
    }
    return {
      action: "domain",
      available: true,
      paying: true,
      owner,
      domain: domainView(id, owner),
      settingsUrl: `${APP}/console/@${handleOf(id)}?settings=website`,
      ...(message === undefined ? {} : { message }),
    };
  }

  return {
    events: () => [...events],
    /** The stub control plane's `options.site(cleared, body)`. */
    async answer(cleared, body) {
      const id = cleared.workspaceId;
      if (body.action === "status") return { action: "status", ...status(id) };
      if (body.action === "check") {
        const now = status(id);
        return {
          action: "check",
          enabled: true,
          draft: now.draft,
          routes: now.pages.filter((page) => page.address !== null).map((page) => ({ address: page.address, path: page.path, status: page.status, audience: "public" })),
          pageProblems: [],
          links: [],
          pictures: [],
          code: [],
          warnings: [],
          more: { links: 0, removed: 0 },
          inspected: null,
        };
      }
      if (body.action === "publish") {
        const now = status(id);
        if (typeof body.draft === "string" && body.draft !== now.draft) {
          return { action: "publish", published: false, conflict: true, draft: now.draft, revision: null, addresses: [], problems: [] };
        }
        const site = siteOf(id);
        site.revision += 1;
        site.published = new Map(pages(id).map((page) => [page.path, page.etag]));
        events.push("publish");
        return { action: "publish", published: true, draft: now.draft, revision: site.revision, addresses: addresses(id), problems: [] };
      }
      if (body.action === "domain") return domain(id, cleared.role === "owner", body.hostname);
      if (body.action === "history") return { action: "history", versions: [], version: null };
      return { action: "screenshot", url: null, address: null, revision: null, message: "Screenshots aren't part of the benchmark." };
    },
  };
}
