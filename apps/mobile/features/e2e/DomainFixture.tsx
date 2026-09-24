import { useDemoConsoleData } from "../console/useDemoConsoleData";
import { SettingsOverlay } from "../console/settings/SettingsOverlay";
import { DomainViewOverride } from "../console/settings/panels/DomainPanel";
import type { DomainView } from "../console/domain/domain";
import type { DomainActions, DomainPanelView } from "../console/domain/useDomain";

/**
 * Settings › Domain in one chosen state, inside the real settings overlay, for
 * reviewing the design in a browser. `?screen=domain&at=<state>` (`oneclick` is a provider with our template).
 */
const noop = async () => {};
const ACTIONS: DomainActions = { connect: noop, checkNow: noop, setHomepage: noop, remove: noop };

const RECORDS = (host: string, apex: boolean, found: { routing: boolean; ownership: boolean }) => [
  {
    purpose: "routing" as const,
    type: apex ? "ALIAS" : "CNAME",
    name: host,
    host: apex ? "@" : host.split(".")[0]!,
    value: "customers.context.lc",
    done: found.routing,
  },
  {
    purpose: "ownership" as const,
    type: "TXT",
    name: `_context.${host}`,
    host: apex ? "_context" : `_context.${host.split(".")[0]}`,
    value: "context-verification=4f1c2a9e7b3d4c8a9e0f1a2b3c4d5e6f",
    done: found.ownership,
  },
];

function domain(over: Partial<DomainView> = {}): DomainView {
  const hostname = over.hostname ?? "docs.acme.com";
  const apex = over.apex ?? false;
  return {
    id: "fixture",
    hostname,
    apex,
    status: "pending",
    stage: "ownership",
    ownershipVerified: false,
    routingVerified: false,
    httpsReady: false,
    problem: null,
    homeSlug: null,
    checkedAt: Date.now() - 20_000,
    records: RECORDS(hostname, apex, { routing: false, ownership: false }),
    oneClick: null,
    ...over,
  };
}

function viewFor(at: string | undefined): DomainPanelView {
  const base = { failed: false, homepageChoices: [{ slug: "intake", title: "Client intake" }], actions: ACTIONS };
  const settings = { available: true, paying: true, canManage: true };
  switch (at) {
    case "upsell":
      return { ...base, settings: { ...settings, paying: false, domain: null } };
    case "pending":
      return {
        ...base,
        settings: {
          ...settings,
          domain: domain({
            ownershipVerified: true,
            stage: "routing",
            records: RECORDS("docs.acme.com", false, { routing: false, ownership: true }),
          }),
        },
      };
    case "oneclick":
      return {
        ...base,
        settings: {
          ...settings,
          domain: domain({ oneClick: { provider: "GoDaddy", url: "https://dcc.provider.example/apply" } }),
        },
      };
    case "apex":
      return { ...base, settings: { ...settings, domain: domain({ hostname: "acme.com", apex: true }) } };
    case "issuing":
      return {
        ...base,
        settings: {
          ...settings,
          domain: domain({ ownershipVerified: true, routingVerified: true, stage: "https", records: [] }),
        },
      };
    case "live":
      return {
        ...base,
        settings: {
          ...settings,
          domain: domain({
            status: "active",
            stage: "live",
            ownershipVerified: true,
            routingVerified: true,
            httpsReady: true,
            homeSlug: "intake",
          }),
        },
      };
    case "attention":
      return { ...base, settings: { ...settings, domain: domain({ problem: "TIMED_OUT" }) } };
    case "paused":
      return { ...base, settings: { ...settings, paying: false, domain: domain({ status: "suspended" }) } };
    case "member": {
      const { actions: _omit, ...rest } = base;
      return {
        ...rest,
        settings: {
          ...settings,
          canManage: false,
          domain: domain({ status: "active", stage: "live", httpsReady: true, records: [] }),
        },
      };
    }
    default:
      return { ...base, settings: { ...settings, domain: null } };
  }
}

export function DomainFixture({ at }: { at?: string }) {
  const data = useDemoConsoleData();
  return (
    <DomainViewOverride.Provider value={viewFor(at)}>
      <SettingsOverlay data={data} section="domain" onSelect={() => {}} onDismiss={() => {}} />
    </DomainViewOverride.Provider>
  );
}
