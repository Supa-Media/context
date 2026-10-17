/**
 * The starting layouts an agent may lay down in a workspace, by name.
 *
 * The app's workspace flow offers the same choices
 * (`apps/mobile/features/workspace/presets.ts`): `para` is the control plane's
 * own five folders, and `business` and `product` are those five plus the
 * extras the owner chose for each (2026-10-08) — clients and teams for a
 * business, teams and products for a product company. Both go to
 * `applyStructure` as a `custom` layout with these rows, exactly as the app
 * sends them; `apps/mobile/__tests__/workspaceCreate.test.ts` fails if the
 * two lists drift.
 */

import { DEFAULT_FOLDER, ROLE_DESCRIPTION, type FolderRole } from "@context/shared/src/folderRoles.cjs";

const BUSINESS: readonly FolderRole[] = ["inbox", "projects", "areas", "resources", "clients", "teams", "archive"];
const PRODUCT: readonly FolderRole[] = ["inbox", "projects", "areas", "resources", "teams", "products", "archive"];

export const LAYOUT_NAMES = ["para", "business", "product"] as const;
export type LayoutName = (typeof LAYOUT_NAMES)[number];

export function isLayoutName(value: unknown): value is LayoutName {
  return typeof value === "string" && (LAYOUT_NAMES as readonly string[]).includes(value);
}

/** What `applyStructure` is handed for a layout: its template and, for a custom one, the rows. */
export function layoutStructure(
  name: LayoutName,
): { template: "para" } | { template: "custom"; folders: { folder: string; description: string }[] } {
  if (name === "para") return { template: "para" };
  const roles = name === "business" ? BUSINESS : PRODUCT;
  return {
    template: "custom",
    folders: roles.map((role) => ({ folder: DEFAULT_FOLDER[role], description: ROLE_DESCRIPTION[role] })),
  };
}
