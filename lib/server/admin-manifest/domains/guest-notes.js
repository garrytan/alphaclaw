// Guest notes: group members' saves, kept as outside-guest pages in the
// owner's brain. The agent reads status; turning a group on or off is humans
// only. Keeping a note is a gbrain promotion, not an AlphaClaw op. The
// internal claim and save routes are not API routes.
module.exports = {
  domain: "guest-notes",
  title: "Guest notes",
  summary: "Group members' saved notes, kept as outside-guest pages in the brain",
  ops: [
    {
      id: "guest-notes.status",
      title: "Guest notes status: whether the brain supports them, and each group's setting and counts",
      method: "GET",
      path: "/api/guest-notes",
      tier: "safe",
      idempotent: true,
    },
    {
      id: "guest-notes.group-set",
      title: "Turn guest notes on or off for a group (humans only)",
      method: "PUT",
      path: "/api/guest-notes/groups/:groupKey",
      tier: "denied",
      idempotent: true,
    },
  ],
};
