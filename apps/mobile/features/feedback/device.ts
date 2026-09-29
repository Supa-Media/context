import { Platform } from "react-native";
import { FEEDBACK_PLATFORMS, VERSION_PATTERN, type FeedbackPlatform, type SystemFamily } from "@context/shared";

/**
 * "App and device" on the report screen: which app, which build, and which
 * browser or system with its major version. Nothing finer — no model, no
 * screen size, no user agent string, which is detailed enough to single a
 * person out.
 */

export interface ReportDevice {
  app: { platform: FeedbackPlatform; build?: string };
  system?: { family: SystemFamily; version?: string };
}

function version(value: unknown): string | undefined {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return VERSION_PATTERN.test(text) ? text : undefined;
}

/** The browser behind a user agent, with its major version. Order matters: Edge and Chrome both say Chrome. */
export function browserOf(userAgent: string): { family: SystemFamily; version?: string } {
  const rules: Array<[SystemFamily, RegExp]> = [
    ["edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ["firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
    ["chrome", /\b(?:Chrome|CriOS)\/(\d+)/],
    ["safari", /\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
  ];
  for (const [family, pattern] of rules) {
    const match = pattern.exec(userAgent);
    if (match !== null) return { family, version: version(match[1]) };
  }
  return { family: "other" };
}

export function describeDevice(input: {
  os: string;
  osVersion: unknown;
  userAgent?: string;
  build?: string;
}): ReportDevice {
  const platform: FeedbackPlatform = (FEEDBACK_PLATFORMS as readonly string[]).includes(input.os)
    ? (input.os as FeedbackPlatform)
    : "web";
  const build = version(input.build?.slice(0, 12));
  const app = build === undefined ? { platform } : { platform, build };
  if (platform === "web") {
    return { app, system: browserOf(input.userAgent ?? "") };
  }
  // iOS reports "17.4.1"; Android reports its API level. The major is enough.
  const major = version(String(input.osVersion ?? "").split(".")[0]);
  return { app, system: major === undefined ? { family: platform } : { family: platform, version: major } };
}

export function reportDevice(): ReportDevice {
  return describeDevice({
    os: Platform.OS,
    osVersion: Platform.Version,
    userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
    build: process.env.EXPO_PUBLIC_APP_BUILD,
  });
}

const FAMILY_NAMES: Record<SystemFamily, string> = {
  chrome: "Chrome",
  safari: "Safari",
  firefox: "Firefox",
  edge: "Edge",
  ios: "iOS",
  android: "Android",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  other: "another browser",
};

/** The "App and device" row on the report screen: exactly what `reportDevice` sends, in words. */
export function describeForPerson(value: ReportDevice): string {
  const app = value.app.platform === "web" ? "Context on the web" : "Context app";
  const build = value.app.build === undefined ? app : `${app}, build ${value.app.build}`;
  if (value.system === undefined) return build;
  const system = FAMILY_NAMES[value.system.family];
  return value.system.version === undefined ? `${build}, ${system}` : `${build}, ${system} ${value.system.version}`;
}
