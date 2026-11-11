import { View } from "react-native";
import { AdminChrome } from "../admin/AdminPane";
import { ConsoleHeader } from "../admin/ConsoleHeader";
import { FeaturesView } from "../admin/FeaturesSection";

/**
 * The staff console's Features tab on invented flags, for reviewing the design in a browser:
 * `/e2e-fixture?screen=features` (`&at=empty` for no tester groups). Changes go nowhere. Names and descriptions are
 * long on purpose, so every row has to hold them.
 */
const now = Date.now();
const DAY = 86_400_000;

const GROUPS = [
  { groupId: "g1", name: "Dogfood", people: ["@fixture", "@another-fixture-person", "ada@example.com", "+1 555 0100"].map((name, i) => ({ userId: `u${i}`, name })) },
  { groupId: "g2", name: "Friends and family", people: [{ userId: "u9", name: "@bo" }] },
];

const listed = (empty: boolean) => ({
  today: "2026-11-11",
  flags: [
    {
      id: "mail.in-notes",
      label: "Mail in notes",
      description: "Gmail is copied into the person's notes again, so new mail starts a Tex check-in at once.",
      added: "2026-11-08",
      expires: "2027-02-06",
      daysLeft: 87,
      due: false,
      mode: "people" as const,
      updatedAt: now - 2 * DAY,
      people: [{ userId: "u0", name: "@fixture" }],
      groups: empty ? [] : [{ groupId: "g2", name: "Friends and family", size: 1 }],
    },
    {
      id: "calendar.in-notes",
      label: "Calendar in notes",
      description: "Events are written as notes in the person's calendar folder, and a change made in either place reaches the other within a minute.",
      added: "2026-10-01",
      expires: "2026-11-16",
      daysLeft: 5,
      due: true,
      mode: "everyone" as const,
      updatedAt: now - 21 * DAY,
      people: [{ userId: "u1", name: "@another-fixture-person" }, { userId: "u2", name: "ada@example.com" }],
      groups: [],
    },
    {
      id: "drawings.shared",
      label: "Shared drawings",
      description: "Two people can draw on one Excalidraw page at the same time.",
      added: "2026-11-01",
      expires: "2026-11-09",
      daysLeft: -2,
      due: true,
      mode: "off" as const,
      updatedAt: null,
      people: [],
      groups: [],
    },
  ],
  groups: empty ? [] : GROUPS,
  retired: empty ? [] : [{ id: "tex.old-voice", rows: 2 }],
});

export function FeaturesFixture({ empty }: { empty: boolean }) {
  return (
    <AdminChrome>
      <ConsoleHeader tab="features" onTab={() => {}} days={30} onDays={() => {}} unsetCount={1} />
      <View style={{ marginTop: 24 }}>
        <FeaturesView listed={listed(empty) as never} />
      </View>
    </AdminChrome>
  );
}
