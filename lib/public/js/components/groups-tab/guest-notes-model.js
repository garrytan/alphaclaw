// The Groups page's guest notes section, as a pure model: which groups can
// have guest notes, and what the section says about the brain's support.
// A member's guest note is saved only in a group where people other than
// the owner can use tools, so only Approved and Trusted groups are listed.
const kGuestNotesModes = new Set(["approved", "trusted"]);

export const guestNotesGroupKey = (group) => "telegram:" + String(group?.groupId || "");

export const kGuestNotesUnavailableCopy = {
  no_credential: "AlphaClaw has no gbrain credential for guest notes on this box (guest-writes/broker-client.json), so they can't be turned on.",
  no_guest_marker: "This brain's gbrain doesn't mark guest notes yet, so they can't be turned on. They stay off until it does, so no guest note is ever saved without its warning.",
  gbrain_unreachable: "AlphaClaw couldn't reach gbrain to check whether it supports guest notes. Try Refresh in a minute.",
};

export const describeGuestNotes = ({ status, groups = [] } = {}) => {
  const listed = (Array.isArray(groups) ? groups : []).filter((group) => group?.groupId && kGuestNotesModes.has(group.mode));
  const settings = status?.groups || {};
  const rows = listed.map((group) => {
    const key = guestNotesGroupKey(group);
    const setting = settings[key] || {};
    return {
      key,
      group,
      enabled: setting.enabled === true,
      live: Number.isInteger(setting.live) ? setting.live : 0,
      dailyCap: setting.dailyCap ?? status?.defaults?.dailyCap ?? 20,
      liveCap: setting.liveCap ?? status?.defaults?.liveCap ?? 200,
    };
  });
  const available = status?.available === true;
  return {
    available,
    unavailable: available ? null : kGuestNotesUnavailableCopy[status?.reason] || kGuestNotesUnavailableCopy.no_guest_marker,
    retentionDays: status?.retentionDays ?? 90,
    rows,
  };
};
