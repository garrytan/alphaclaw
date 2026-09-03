const loadCalendarHelpers = async () =>
  import("../../lib/public/js/components/cron-tab/cron-calendar-helpers.js");

// MW4: the cron calendar parser must handle name aliases and range-with-step,
// and an unparseable field must plot nothing rather than everything.
// (The test env runs in UTC, matching the other cron-calendar tests.)
describe("frontend/cron-calendar-helpers MW4 parsing", () => {
  it("plots MON-FRI only on weekdays, never Sat/Sun", async () => {
    const { expandJobsToRollingSlots } = await loadCalendarHelpers();
    // 2026-03-11 is a Wednesday; a +/-3 day window spans the weekend.
    const nowMs = Date.UTC(2026, 2, 11, 10, 0, 0);
    const { slots } = expandJobsToRollingSlots({
      jobs: [
        {
          id: "weekdays",
          name: "Weekday 9am",
          schedule: { kind: "cron", expr: "0 9 * * MON-FRI" },
        },
      ],
      nowMs,
      pastDays: 3,
      futureDays: 3,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const dow = new Date(slot.scheduledAtMs).getDay();
      expect(dow).not.toBe(0); // Sunday
      expect(dow).not.toBe(6); // Saturday
      expect(new Date(slot.scheduledAtMs).getHours()).toBe(9);
    }
  });

  it("expands 0-30/5 to 7 slots per hour, not 60 (no blowup)", async () => {
    const { expandJobsToRollingSlots } = await loadCalendarHelpers();
    const nowMs = Date.UTC(2026, 2, 11, 10, 0, 0);
    const { slots } = expandJobsToRollingSlots({
      jobs: [
        {
          id: "stepped",
          name: "Every 5m in first half hour",
          schedule: { kind: "cron", expr: "0-30/5 * * * *" },
        },
      ],
      nowMs,
      pastDays: 0,
      futureDays: 0,
    });
    // Only minutes {0,5,10,15,20,25,30} — 7 per hour, a bounded set.
    const minutes = new Set(
      slots.map((slot) => new Date(slot.scheduledAtMs).getMinutes()),
    );
    expect([...minutes].sort((a, b) => a - b)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    // 7 minutes/hour across the rolling window — far fewer than the 60/hour a
    // match-all blowup would produce (the exact window size doesn't matter).
    const hoursInWindow = new Set(
      slots.map((slot) => Math.floor(slot.scheduledAtMs / (60 * 60 * 1000))),
    ).size;
    expect(slots.length).toBe(7 * hoursInWindow);
  });

  it("plots nothing for an unparseable field (not everything)", async () => {
    const { expandJobsToRollingSlots } = await loadCalendarHelpers();
    const nowMs = Date.UTC(2026, 2, 11, 10, 0, 0);
    const { slots } = expandJobsToRollingSlots({
      jobs: [
        {
          id: "garbage",
          name: "Unparseable",
          // 99 is out of range for minutes → empty set → must match nothing.
          schedule: { kind: "cron", expr: "99 9 * * *" },
        },
      ],
      nowMs,
      pastDays: 1,
      futureDays: 1,
    });
    expect(slots).toEqual([]);
  });
});
