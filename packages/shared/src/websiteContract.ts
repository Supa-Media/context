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
    };

export type WebsiteEnableResult = Extract<
  WebsiteStateView,
  { state: "enabled" }
> & {
  /** Whether this call created the ordinary starter homepage. */
  starter: "created" | "existing";
};

export type WebsiteRouteAudience = "public" | "members";
export type WebsiteRoutePublicationStatus = "live" | "draft" | "problem";
export type WebsiteRouteProblemCode =
  | WebsiteRouteDiagnosticCode
  | "invalid_metadata"
  | "empty_page"
  | "untitled_page";

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
    if (route.status === "problem") summary.problems += 1;
    else if (route.status === "draft") summary.drafts += 1;
    else if (route.audience === "members") summary.members += 1;
    else summary.public += 1;
  }
  return summary;
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
