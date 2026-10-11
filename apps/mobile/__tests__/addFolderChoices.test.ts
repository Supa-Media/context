/**
 * Which built-in folders "Add a folder" offers, without a renderer.
 *
 * The question is "which of these does the workspace not have?", and it is
 * answered the way the server answers it (`rolesIn`), so a folder named the
 * way an older workspace named it is still a folder the workspace has.
 */

import { describe, expect, test } from "@jest/globals";
import { addFolderChoices } from "../features/console/files/addFolderChoices";

const roles = (names: string[]) => addFolderChoices(names).map((choice) => choice.role);

describe("which built-in folders are offered", () => {
  test("a brand-new workspace is offered the three extras, in their order", () => {
    expect(roles(["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"])).toEqual([
      "clients",
      "teams",
      "products",
    ]);
  });

  test("an extra the workspace has is not offered, by any of the names it could have", () => {
    expect(roles(["0-inbox", "clients", "7-Teams", "products", "1-projects", "2-areas", "3-resources", "9-archive"])).toEqual(
      [],
    );
    expect(roles(["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive", "4-Clients", "5-teams"])).toEqual([
      "products",
    ]);
    expect(roles(["7-Clients"])).not.toContain("clients");
  });

  test("a main folder an older workspace lacks is offered first, before the extras", () => {
    expect(roles(["0-inbox", "1-projects", "2-areas", "9-archive"])).toEqual([
      "resources",
      "clients",
      "teams",
      "products",
    ]);
  });

  test("main folders are offered in their own order, not the order they were missing in", () => {
    expect(roles(["3-resources", "2-areas"])).toEqual(["inbox", "projects", "archive", "clients", "teams", "products"]);
  });

  test("Archive, a main role, is offered when there is no archive folder", () => {
    expect(roles(["0-inbox", "1-projects", "2-areas", "3-resources"])).toContain("archive");
  });

  test("a folder that only looks like a role is not one", () => {
    // `old-archive` and `archive-2024` are nobody's archive, so Archive is still missing.
    expect(roles(["old-archive", "archive-2024"])).toContain("archive");
  });

  test("the choices carry the label and the one line the mockup shows", () => {
    const [first] = addFolderChoices(["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"]);
    expect(first).toEqual({
      role: "clients",
      label: "Clients",
      description: expect.stringMatching(/client/i),
    });
  });

  test("a workspace with nothing missing is offered nothing", () => {
    expect(addFolderChoices([])).toHaveLength(8);
    expect(
      addFolderChoices(["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive", "4-clients", "5-teams", "6-products"]),
    ).toEqual([]);
  });
});
