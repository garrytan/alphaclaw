import { describe, expect, it } from "vitest";
import { describeGuestNotes, guestNotesGroupKey } from "../../lib/public/js/components/groups-tab/guest-notes-model.js";

describe("Groups page guest notes model", () => {
  const groups = [
    { groupId: "-1001", mode: "approved", title: "Trip" },
    { groupId: "-1002", mode: "trusted", title: "Work" },
    { groupId: "-1003", mode: "silent", title: "Quiet" },
  ];

  it("lists only approved and trusted groups, keyed by channel and chat id", () => {
    const view = describeGuestNotes({ status: { available: true, groups: { "telegram:-1001": { enabled: true, live: 3, dailyCap: 20, liveCap: 200 } } }, groups });
    expect(view.rows.map((row) => row.key)).toEqual(["telegram:-1001", "telegram:-1002"]);
    expect(view.rows[0]).toMatchObject({ enabled: true, live: 3 });
    expect(view.rows[1]).toMatchObject({ enabled: false, live: 0 });
    expect(view.unavailable).toBeNull();
    expect(guestNotesGroupKey({ groupId: "-5" })).toBe("telegram:-5");
  });

  it("says why guest notes can't be turned on", () => {
    expect(describeGuestNotes({ status: { available: false, reason: "no_credential" }, groups }).unavailable).toMatch(/broker-client\.json/);
    expect(describeGuestNotes({ status: null, groups }).unavailable).toMatch(/doesn't mark guest notes/);
  });
});
