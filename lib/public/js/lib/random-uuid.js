// crypto.randomUUID exists only in secure contexts (HTTPS or localhost). A VPS
// reached by IP over plain HTTP has no randomUUID, so the chat could not send a
// message. crypto.getRandomValues works in every context; build the same v4
// UUID from it there.
export const randomUuid = (cryptoImpl = globalThis.crypto) => {
  if (typeof cryptoImpl?.randomUUID === "function") return cryptoImpl.randomUUID();
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
