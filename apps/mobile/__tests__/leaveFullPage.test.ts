import { describe, expect, it } from "@jest/globals";
import { leaveFullPages } from "../features/console/layout/leaveFullPage";

describe("a click in the tree leaves the full pages", () => {
  const pages = (open: { mail?: boolean; map?: boolean; trash?: boolean }) => {
    const closed: string[] = [];
    return {
      closed,
      pages: {
        mail: { open: open.mail === true, closeMail: () => closed.push("mail") },
        map: { open: open.map === true, closeMap: () => closed.push("map") },
        trash: { open: open.trash === true, closeTrash: () => closed.push("trash") },
      },
    };
  };

  it("closes Agent Mail, the map and the trash when open", () => {
    for (const which of ["mail", "map", "trash"] as const) {
      const { closed, pages: p } = pages({ [which]: true });
      leaveFullPages(p);
      expect(closed).toEqual([which]);
    }
  });

  it("touches nothing when no full page is open, so a plain click writes no URL", () => {
    const { closed, pages: p } = pages({});
    leaveFullPages(p);
    expect(closed).toEqual([]);
  });

  it("is a no-op outside the console, where no route is provided", () => {
    expect(() => leaveFullPages({})).not.toThrow();
  });
});
