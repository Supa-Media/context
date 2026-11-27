export interface BotApp {
  readonly label: string;
  readonly reach: "webhook" | "mail";
  readonly why: string;
}
export declare const BOT_APPS: Readonly<Record<string, BotApp>>;
export declare function appOf(kind: unknown): BotApp | null;
export declare function reachOf(reach: unknown, kind: unknown): "webhook" | "mail";
export declare function checkInSteps(input: { holder: string; kind?: string; workspace?: string }): string[];
