/**
 * Website state and rendering contracts shared by the control plane and app.
 *
 * This module contains wire shapes, not authorization. Convex produces the
 * lifecycle and owner-facing status views; the public resolver produces the
 * page union. Keeping those unions here means the app can render each state
 * without copying the server's rules for deciding which state applies.
 */

import {
  DEFAULT_WEBSITE_ROOT,
  type WebsiteRouteDiagnosticCode,
} from "./websiteRoutes";
import type { WebsiteCodeRole } from "./siteDesign/codeNotes";

export const WEBSITE_CONTRACT_VERSION = 1 as const;

/** The starter is deliberately ordinary Markdown and may be edited or deleted. */
export const WEBSITE_STARTER_MARKDOWN = `---
title: Home
---

# Home

Welcome to my website.
`;

export type WebsiteStateView =
  | {
      contractVersion: typeof WEBSITE_CONTRACT_VERSION;
      state: "disabled";
      root: typeof DEFAULT_WEBSITE_ROOT;
      /** Relative so staging, production and custom app origins stay honest. */
      handlePath: string;
      canManage: boolean;
    }
  | {
      contractVersion: typeof WEBSITE_CONTRACT_VERSION;
      state: "enabled";
      root: typeof DEFAULT_WEBSITE_ROOT;
      handlePath: string;
      canManage: boolean;
      enabledAt: number;
      /** An owner or editor: edits reach visitors when one presses Publish. */
      canPublish?: boolean;
      /** The last Publish that landed; absent before the first. */
      publishedAt?: number;
    };

export type WebsiteEnableResult = Extract<
  WebsiteStateView,
  { state: "enabled" }
> & {
  /** Whether this call created the ordinary starter homepage. */
  starter: "created" | "existing";
};

/**
 * What pressing Publish did. `published: false` with no problems means edits
 * kept landing while it read the folder; pressing again finishes it.
 */
export interface WebsitePublishResult {
  published: boolean;
  /** The pages that stopped it, by file under the website folder. */
  problems: Array<{ path: string; message: string }>;
}

export type WebsiteRouteAudience = "public" | "members";
export type WebsiteRoutePublicationStatus = "live" | "draft" | "problem";
export type WebsiteRouteProblemCode =
  | WebsiteRouteDiagnosticCode
  | "invalid_metadata"
  | "devlog_promise"
  | "code_note";

export interface WebsiteRouteProblem {
  code: WebsiteRouteProblemCode;
  /** Owner-facing. Never put this on a public unavailable response. */
  message: string;
}

/** One bucket note as the authenticated console may describe it. */
export interface WebsiteRouteStatus {
  objectKey: string;
  /** Null only when an unsafe key cannot claim a route. */
  routePath: string | null;
  status: WebsiteRoutePublicationStatus;
  audience: WebsiteRouteAudience;
  title: string | null;
  description: string | null;
  nav: number | null;
  problems: WebsiteRouteProblem[];
  /**
   * Set on a code note (`./siteDesign/codeNotes.ts`). Only `html`, an
   * all-HTML page, has an address; the rest have a null `routePath` and are
   * drawn into the pages rather than served as one.
   */
  code?: WebsiteCodeRole;
}

export interface WebsiteRouteSummary {
  total: number;
  public: number;
  members: number;
  drafts: number;
  problems: number;
}

/**
 * The single counting rule for the Website card and activation review.
 *
 * Problem and draft rows do not also count as live, even when their parsed
 * audience is public or members. That makes every route land in one bucket and
 * keeps `total` equal to the four visible counts.
 */
export function summarizeWebsiteRoutes(
  routes: readonly WebsiteRouteStatus[],
): WebsiteRouteSummary {
  const summary: WebsiteRouteSummary = {
    total: routes.length,
    public: 0,
    members: 0,
    drafts: 0,
    problems: 0,
  };
  for (const route of routes) {
    // A layout or stylesheet is part of every page, not a page of its own;
    // only a broken one is worth a count, so the owner goes and looks.
    if (route.code !== undefined && route.code !== "html" && route.status !== "problem") {
      summary.total -= 1;
      continue;
    }
    if (route.status === "problem") summary.problems += 1;
    else if (route.status === "draft") summary.drafts += 1;
    else if (route.audience === "members") summary.members += 1;
    else summary.public += 1;
  }
  return summary;
}

/** A page's design as the resolver hands it over (`siteDesign/`). */
export interface WebsiteDesign {
  /** `layout.html.md`'s sanitized HTML, or null for the default frame. */
  frame: string | null;
  /** The page's named layout, or an HTML page's own HTML, sanitized. */
  template: string | null;
  /** Every stylesheet, scoped to the page's container. */
  css: string;
  /** Google Fonts stylesheets to load. */
  fonts: string[];
  /** Present, and false, only when a note the page is drawn with says `base: off`. */
  base?: false;
}

export interface WebsiteNavigationItem {
  routePath: string;
  title: string;
}

/**
 * The public resolver's whole response.
 *
 * `unavailable` intentionally has no reason. A missing route, disabled site,
 * draft, collision and authorization refusal are one public answer. The
 * authenticated status contract above is where repair details belong.
 */
export type ResolvedWebsitePage =
  | {
      kind: "page";
      siteName: string;
      routePath: string;
      audience: WebsiteRouteAudience;
      title: string;
      description: string | null;
      markdown: string;
      navigation: WebsiteNavigationItem[];
      /**
       * The workspace emoji the page uses, `name → data: URL`: a site loads no
       * images, so a `:name:` it shows comes with the page. Absent names show
       * as their text.
       */
      emoji?: Record<string, string>;
      /**
       * The stored pictures the page embeds, `leaf → data: URL`, for the same
       * reason: `![[paste-….png]]` comes with the page. An absent leaf shows
       * as missing.
       */
      images?: Record<string, string>;
      /**
       * The site's own design, when it has code notes and its plan draws
       * them: already sanitized, and composed and sanitized again where it
       * is drawn. Absent, the page has the default look.
       */
      design?: WebsiteDesign;
    }
  | {
      kind: "authentication_required";
      siteName: string;
      /** Public live pages explicitly placed in the site menu. */
      navigation: WebsiteNavigationItem[];
      /** Server-produced and validated; clients must not construct return URLs. */
      signInPath: string;
    }
  | {
      kind: "unavailable";
      /** Null when no enabled site may be disclosed for this address. */
      siteName: string | null;
      /** Empty beside a null site name; otherwise the same public menu. */
      navigation: WebsiteNavigationItem[];
    };

/** Website-first address resolution, with an existing named share as fallback. */
export type ResolvedWebsiteAddress =
  | ResolvedWebsitePage
  | {
      kind: "legacy_short_link";
      handle: string;
      slug: string;
    };
