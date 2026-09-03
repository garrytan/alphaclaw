// Hash-route query parsing. useHashLocation splits routes on "?" so a query
// string can ride the hash without breaking route matching (the shipped
// #/watchdog?incident=<id> anchor relies on this). Shared here so features
// stop hand-rolling parsers — the watchdog incidents parser
// (components/watchdog-tab/incidents/helpers.js) migrates later (TODOS.md).
export const readHashQueryParam = (hash, key) => {
  const raw = String(hash || "");
  const queryIndex = raw.indexOf("?");
  if (queryIndex === -1 || !key) return "";
  try {
    return new URLSearchParams(raw.slice(queryIndex + 1)).get(key) || "";
  } catch {
    return "";
  }
};
