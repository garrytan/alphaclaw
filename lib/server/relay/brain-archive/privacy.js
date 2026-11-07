const { redactSecretText } = require("../../utils/redact");

// What a brain page may not carry, beyond the relay masker (collected secret
// values + redactSecretText): URLs that carry a credential, private keys and
// key = value assignments of secret-named settings, and Garry's private
// classes (email content, raw meeting notes, health, family), which are
// withheld even when a peer quotes them. A page that still trips the scanner
// after all of that is refused, never written (masked_refused).
const kWithheld = "[withheld: private class]";
const kUrlRemoved = "[credential URL removed]";
const kKeyRemoved = "[private key removed]";

// Every quantifier here is bounded and no two adjacent ones can match the
// same characters, so a crafted message costs linear time (CSO ALPH-71: the
// first kSecretAssignment froze the event loop for ~55 s on 16 KB).
const kMaxScanChars = 64 * 1024;
const kUrlPattern = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'\x60)\]]+/gi;
const kUrlCredentialParam = /[?&#](?:sig|signature|token|key|apikey|api_key|access_token|refresh_token|id_token|auth|password|passwd|pwd|secret|client_secret|code|bootstrapToken|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential)=/i;
const kPrivateKeyBlock = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const kSecretAssignment =
  /((?:api[_-]?key|secret|password|passwd|token|private[_-]?key|access[_-]?key|client[_-]?secret|credential)(?=([A-Za-z0-9_.-]{0,64}))\2)([ \t]{0,8}[:=][ \t]{0,8})(["']?)(?=([^\s"']+))\5/gi;

// Parameter names are compared after percent-decoding (repeatedly, so a
// double-encoded name is found too).
const decodePercent = (text) => {
  let value = text;
  for (let round = 0; round < 3; round += 1) {
    const next = value.replace(/%([0-9a-f]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === value) break;
    value = next;
  }
  return value;
};

const isCredentialUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return true;
  } catch {
    if (/:\/\/[^/\s@]+@/.test(url)) return true;
  }
  return kUrlCredentialParam.test(url) || kUrlCredentialParam.test(decodePercent(url));
};

const stripCredentialUrls = (text) => String(text ?? "").replace(kUrlPattern, (url) => (isCredentialUrl(url) ? kUrlRemoved : url));

const maskSecretShapes = (text) =>
  String(text ?? "")
    .replace(kPrivateKeyBlock, kKeyRemoved)
    .replace(kSecretAssignment, (match, key, suffix, sep, quote, value) => (value.length < 8 || value === "***" ? match : key + sep + quote + "***"));

// Private classes. Paragraph rules first (an email or a meeting transcript
// is a block), then line rules (one health or family line, one address).
const kEmailHeader = /^[ \t]{0,16}>?[ \t]{0,4}(from|to|cc|bcc|subject|reply-to|sent|date)[ \t]{0,4}:[ \t]{0,8}\S/i;
const kEmailMarkers = /(-{2,8}[ \t]{0,4}(original|forwarded) message[ \t]{0,4}-{2,8}|^[ \t]{0,16}begin forwarded message|^[ \t]{0,16}on [^\n]{4,120} wrote:[ \t]{0,8}$)/im;
const kEmailAddress = /\b(?=([A-Za-z0-9._%+-]{1,64}))\1@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/;
const kMeetingMarkers =
  /\b(meeting (notes|transcript|minutes|recording)|minutes of (the )?meeting|call transcript|transcript of|attendees\s*:|action items\s*:|granola|otter\.ai|fireflies)\b/i;
const kSpeakerLine = /^[ \t]{0,16}(\[?\(?\d{1,2}:\d{2}(:\d{2})?\)?\]?[ \t]{0,4}[-–]?[ \t]{0,4})?[A-Z][A-Za-z.'-]{0,30}(?: [A-Za-z.'-]{1,30}){0,3}[ \t]{0,4}:[ \t]{1,8}\S/;
const kSpeakerTime = /^[ \t]{0,16}\[?\(?\d{1,2}:\d{2}(:\d{2})?\)?\]?[ \t]{0,4}[-–]?[ \t]{0,4}/;
const kSpeakerWithTime = /^[ \t]{0,16}\[?\(?\d{1,2}:\d{2}(:\d{2})?\)?\]?[ \t]{0,4}[-–]?[ \t]{0,4}[A-Z][A-Za-z.'-]{0,30}(?: [A-Za-z.'-]{1,30}){0,3}[ \t]{0,4}:[ \t]{1,8}\S/;
const kHealth =
  /\b(medical|medication|medicine|prescription|prescribed|dosage|diagnosed with|blood (test|work|pressure|sugar)|surgery|surgeon|hospital(ized)?|clinic|therapist|therapy session|psychiatr\w*|pregnan\w*|cancer|tumou?r|diabetes|chemo\w*|physician|dentist|illness|vaccin\w*|allerg(y|ies)|mental health|antidepressant|health (record|condition|issue|insurance|history)|symptoms? of|sick (day|leave))\b/i;
const kFamily =
  /\b(my|his|her|garry'?s|their|our)\s+(wife|husband|spouse|partner'?s|son|sons|daughter|daughters|kids?|children|child|baby|mom|mum|dad|mother|father|parents|brother|sister|siblings?|family|grand(ma|pa|mother|father|kids?|children)|in-laws?|nanny|babysitter)\b/i;

const classifyParagraph = (paragraph) => {
  const lines = paragraph.split("\n");
  const headers = lines.filter((line) => kEmailHeader.test(line)).length;
  if (headers >= 2 || kEmailMarkers.test(paragraph)) return "email";
  if (kMeetingMarkers.test(paragraph)) return "meeting";
  if (lines.filter((line) => kSpeakerWithTime.test(line)).length >= 2) return "meeting";
  const turns = new Map();
  for (const line of lines) {
    const speaker = kSpeakerLine.test(line) ? line.replace(kSpeakerTime, "").split(":")[0].trim().toLowerCase() : null;
    if (speaker) turns.set(speaker, (turns.get(speaker) || 0) + 1);
  }
  const repeated = [...turns.values()].filter((count) => count >= 2).length;
  if (repeated >= 2 && [...turns.values()].reduce((sum, count) => sum + count, 0) >= 4) return "meeting";
  return null;
};

const kEmailHeaderLine = /^[ \t]{0,16}>?[ \t]{0,4}(from|subject|reply-to|cc|bcc)[ \t]{0,4}:[ \t]{0,8}\S/i;

const classifyLine = (line) => {
  if ((line.includes("@") && kEmailAddress.test(line)) || kEmailHeaderLine.test(line)) return "email";
  if (kHealth.test(line)) return "health";
  if (kFamily.test(line)) return "family";
  return null;
};

// An email's body follows its headers or its sender's address, so
// everything after an email paragraph or line in the same message is
// withheld with it.
const withholdPrivateClasses = (text) => {
  const withheld = new Set();
  let inEmail = false;
  const out = String(text ?? "")
    .split(/(\n[ \t]*\n)/)
    .map((part) => {
      if (/^\n[ \t]*\n$/.test(part)) return part;
      if (inEmail) return kWithheld;
      const paragraphClass = classifyParagraph(part);
      if (paragraphClass === "email") inEmail = true;
      if (paragraphClass) {
        withheld.add(paragraphClass);
        return kWithheld;
      }
      return part
        .split("\n")
        .map((line) => {
          if (inEmail) return kWithheld;
          const lineClass = classifyLine(line);
          if (!lineClass) return line;
          if (lineClass === "email") inEmail = true;
          withheld.add(lineClass);
          return kWithheld;
        })
        .join("\n");
    })
    .join("");
  return { text: out, withheld: [...withheld].sort() };
};

// Every text that goes on a page: credential URLs out, private classes
// withheld, then the relay masker (collected secrets + shapes), then the
// archive's own secret shapes.
const cleanForBrain = (text, { maskText }) => {
  const value = String(text ?? "");
  const scanned = value.length > kMaxScanChars ? value.slice(0, kMaxScanChars) + "\n[truncated: " + (value.length - kMaxScanChars) + " more characters]" : value;
  const { text: kept, withheld } = withholdPrivateClasses(stripCredentialUrls(scanned));
  return { text: maskSecretShapes(maskText(kept)), withheld };
};

// The last check before a page is written: anything a masker would still
// change, or a secret value it should have caught, refuses the page.
const findSecretResidue = (page, { secrets = [] } = {}) => {
  const text = String(page ?? "");
  if (redactSecretText(text) !== text) return "secret_shape";
  if (maskSecretShapes(text) !== text) return "secret_assignment";
  if (stripCredentialUrls(text) !== text) return "credential_url";
  for (const secret of secrets) {
    const value = String(secret ?? "");
    if (value.length >= 6 && text.includes(value)) return "secret_value";
  }
  return null;
};

module.exports = {
  cleanForBrain,
  findSecretResidue,
  withholdPrivateClasses,
  stripCredentialUrls,
  maskSecretShapes,
  kWithheld,
  kUrlRemoved,
};
