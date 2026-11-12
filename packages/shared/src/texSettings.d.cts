/** Types for `texSettings.cjs`; see that file for the rules and the reasons. */

export type TexSettingWhere = "1:1" | "group";

export interface TexSetting {
  key: string;
  /** What a person calls it, as a row's title. */
  label: string;
  /** One line a person reads. */
  description: string;
  section: "Tex" | "Vault" | "Group chats";
  where: readonly TexSettingWhere[];
  /** Whether Tex changes it from a text. */
  byText: boolean;
  /** The `send` action that changes it, when `byText`. */
  via?: string;
  /** Where in the app it changes, when it doesn't by text. */
  appPath?: string;
}

export declare const TEX_SETTINGS: readonly TexSetting[];
export declare const WHERE: readonly TexSettingWhere[];
export declare function texSetting(key: string): TexSetting | null;
