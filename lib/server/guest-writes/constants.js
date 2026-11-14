const path = require("path");

// Guest notes (GST-2662): a member of a group chat saves a note or a file
// through the guest_save tool, and AlphaClaw's root broker writes it into
// gbrain's "guests" source on that member's behalf. The contract between
// AlphaClaw, the box's guard plugin and gbrain is docs/designs/guest-notes.md.
const kGuestNotesMcpServerName = "guest_notes";
const kGuestNotesManagedOwner = "guest-notes";
const kGuestSaveToolName = "guest_save";
const kGuestSourceId = "guests";
const kBrokerAgentLabel = "alphaclaw-guest-broker";
const kGuestMarkerCapability = "guest_marker_v1";

const kClaimTtlMs = 10 * 60 * 1000;
const kRestoreWindowMs = 72 * 60 * 60 * 1000;
const kSweepIntervalMs = 6 * 60 * 60 * 1000;
const kCapabilityCacheMs = 10 * 60 * 1000;
const kFallbackMemberUid = 10097;
const kMinMemberUid = 10100;
const kMaxTitleChars = 120;
const kMaxSlugSuffix = 20;

const kGuestNotesDefaults = Object.freeze({
  dailyCap: 20,
  liveCap: 200,
  maxNoteBytes: 64 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  retentionDays: 90,
});

const kGroupSlugPattern = /^g[0-9a-f]{16}$/;
const kMemberSlugPattern = /^m[0-9a-f]{16}$/;
const kGroupKeyPattern = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9_.@:-]{1,128}$/;
const kMemberIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

const guestWritesPaths = (rootDir) => {
  const dir = path.join(rootDir, "guest-writes");
  return {
    dir,
    secretFile: path.join(dir, "internal-secret"),
    clientFile: path.join(dir, "broker-client.json"),
    dbFile: path.join(dir, "broker.db"),
    filesDir: path.join(rootDir, "guest-files"),
  };
};

// What the room hears for each refusal (the "what"), and what fixes it.
// Nothing internal: no paths, ids or stacks.
const kGuestErrors = Object.freeze({
  claim_invalid: { what: "I can't save that here.", fix: "Guest notes are saved only for group members, in their own turn." },
  guest_saves_off: { what: "Saving guest notes is off in this group.", fix: "The owner can turn it on in the Groups page." },
  guest_saves_unavailable: { what: "Guest notes aren't available yet.", fix: "The owner's brain or AlphaClaw isn't set up for guest notes yet." },
  guest_cap_reached: { what: "You've reached the limit of guest notes.", fix: "Wait until tomorrow, or ask the owner to raise the limit." },
  guest_note_too_large: { what: "That's too long to save as one note.", fix: "Split it into smaller notes." },
  guest_file_refused: { what: "I can only save a plain file from your scratch folder.", fix: "Save a regular file you wrote in your own scratch folder." },
  guest_save_retry: { what: "I couldn't save that just now; try again in a minute.", fix: "Try the same save again in a minute." },
  guest_save_failed: { what: "That didn't save.", fix: "The owner can check AlphaClaw's log." },
  invalid_input: { what: "That save was malformed.", fix: "Send kind, a title, and either text or file_path." },
});

class GuestWriteError extends Error {
  constructor(code, detail = "") {
    super(code);
    this.code = kGuestErrors[code] ? code : "guest_save_failed";
    this.detail = String(detail || "");
  }
}

module.exports = {
  kGuestNotesMcpServerName,
  kGuestNotesManagedOwner,
  kGuestSaveToolName,
  kGuestSourceId,
  kBrokerAgentLabel,
  kGuestMarkerCapability,
  kClaimTtlMs,
  kRestoreWindowMs,
  kSweepIntervalMs,
  kCapabilityCacheMs,
  kFallbackMemberUid,
  kMinMemberUid,
  kMaxTitleChars,
  kMaxSlugSuffix,
  kGuestNotesDefaults,
  kGroupSlugPattern,
  kMemberSlugPattern,
  kGroupKeyPattern,
  kMemberIdPattern,
  kGuestErrors,
  GuestWriteError,
  guestWritesPaths,
};
