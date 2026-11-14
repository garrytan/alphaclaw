const crypto = require("crypto");

// Page text and slugs for a guest note. Frontmatter is for people reading
// the file (gbrain allows exactly these keys and reads none of them for
// attribution): who the guest was travels as request metadata, which gbrain
// records. The broker writes every frontmatter key itself; nothing the
// member sent reaches the frontmatter except the
// title, which is stripped of control characters and JSON-quoted (a valid
// YAML double-quoted scalar). The member's text goes verbatim inside a
// backtick fence longer than any backtick run it contains, so it can never
// close the fence or add frontmatter. These fields are for people reading
// the file: the warning a model sees comes only from gbrain's own records.
const kTick = "\x60";
const kTickRun = new RegExp(kTick + "+", "g");
const kControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const stripControls = (value) => String(value ?? "").replace(kControls, " ").replace(/\s+/g, " ").trim();

const titleSlug = (title) => {
  const slug = stripControls(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "note";
};

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const guestSlug = ({ groupSlug, memberSlug, day, title, n = 1 }) =>
  "guests/" + groupSlug + "/" + memberSlug + "/" + day + "-" + titleSlug(title) + (n > 1 ? "-" + n : "");

const normalizeNoteText = (text) => String(text ?? "").replace(/\r\n?/g, "\n").normalize("NFC").replace(/\s+$/g, "");

const fenceFor = (text) => {
  let longest = 0;
  for (const match of String(text).matchAll(kTickRun)) longest = Math.max(longest, match[0].length);
  return kTick.repeat(Math.max(4, longest + 1));
};

const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");

const idempotencyKey = ({ runId, kind, contentDigest }) => sha256Hex(String(runId) + "\n" + kind + "\n" + contentDigest);

// A deterministic UUID (version 4 layout) per save attempt, so a retry of the
// same attempt always reuses its request id and a new slug gets a new one.
const requestIdFor = (key, n = 1) => {
  const hex = sha256Hex(key + "\n" + n).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20, 32);
};

const renderGuestPage = ({ title, body, ownerMember, audienceMember, groupSlug, memberSlug, savedAt }) => {
  const fence = fenceFor(body);
  return [
    "---",
    "type: guest-note",
    "title: " + JSON.stringify(stripControls(title)),
    "readable_by: [" + JSON.stringify("member:" + ownerMember) + ", " + JSON.stringify("member:" + audienceMember) + "]",
    "guest_group: " + groupSlug,
    "guest_sender: " + memberSlug,
    "saved_at: " + JSON.stringify(savedAt),
    "---",
    "_Saved by AlphaClaw for a group member. Outside guest's words; not the owner's, not verified._",
    "",
    fence + "text",
    body,
    fence,
    "",
  ].join("\n");
};

// The sender label gbrain accepts in _meta.guest: 1-64 printable
// characters, no newlines or brackets.
const guestLabel = (value) => stripControls(value).replace(/[\[\](){}<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 64).trim() || "guest";

const fileNoteBody = ({ name, size, sha256 }) => "File: " + stripControls(name) + "\nSize: " + size + " bytes\nSHA-256: " + sha256;

module.exports = {
  stripControls,
  titleSlug,
  dayOf,
  guestSlug,
  normalizeNoteText,
  fenceFor,
  sha256Hex,
  idempotencyKey,
  requestIdFor,
  renderGuestPage,
  guestLabel,
  fileNoteBody,
};
