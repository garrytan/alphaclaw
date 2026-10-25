const {
  OPENCLAW_DIR,
  GOG_KEYRING_PASSWORD,
} = require("./constants");
const {
  isValidGoogleClientName,
  kDefaultGoogleClient,
} = require("./google-state");

// The accounts gog itself lists (`gog auth list --json`: read from its
// keyring, no token exchange), with the env every other gog call gets. The
// prompt render is synchronous, so it reads this cache and never spawns; the
// cache is refreshed on boot and after the Google routes change state. Any
// failure caches nothing, which renders exactly what AlphaClaw's own state
// holds (the behaviour before detection).
const kGogAuthListTimeoutMs = 10_000;
const kMaxDetectedGogAccounts = 20;
const kGogEmailPattern = /^[^\s@`<>()[\]{}|\\"']+@[^\s@`<>()[\]{}|\\"']+$/;

let detectedAccounts = [];
let refreshSequence = 0;

const parseGogAuthList = (stdout) => {
  const parsed = JSON.parse(String(stdout || ""));
  const entries = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  const seen = new Set();
  const accounts = [];
  for (const entry of entries) {
    const email = String(entry?.email || "").trim();
    const client = String(entry?.client || "").trim() || kDefaultGoogleClient;
    if (email.length > 254 || !kGogEmailPattern.test(email)) continue;
    if (!isValidGoogleClientName(client)) continue;
    const key = `${client}\n${email.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ email, client });
    if (accounts.length >= kMaxDetectedGogAccounts) break;
  }
  return accounts;
};

const describeFailure = (error) => {
  if (error?.code === "ENOENT") return "gog is not installed";
  if (error?.killed) return "timed out";
  if (typeof error?.code === "number") return `exit ${error.code}`;
  if (error instanceof SyntaxError) return "unparseable output";
  return "failed";
};

// Resolves true when the cached list changed. The newest refresh wins: a
// slower, older one never overwrites it.
const refreshDetectedGogAccounts = async ({
  execFileCmd,
  gogBin = "gog",
  openclawDir = OPENCLAW_DIR,
  keyringPassword = GOG_KEYRING_PASSWORD,
  timeoutMs = kGogAuthListTimeoutMs,
}) => {
  const sequence = ++refreshSequence;
  let accounts = [];
  try {
    const stdout = await execFileCmd(gogBin, ["auth", "list", "--json", "--no-input"], {
      timeout: timeoutMs,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: openclawDir,
        GOG_KEYRING_PASSWORD: keyringPassword,
      },
    });
    accounts = parseGogAuthList(stdout);
  } catch (error) {
    console.log(`[alphaclaw] gog account detection skipped: ${describeFailure(error)}`);
  }
  if (sequence !== refreshSequence) return false;
  const changed = JSON.stringify(accounts) !== JSON.stringify(detectedAccounts);
  detectedAccounts = accounts;
  return changed;
};

const getDetectedGogAccounts = () => detectedAccounts.map((account) => ({ ...account }));

const resetDetectedGogAccountsForTests = () => {
  detectedAccounts = [];
  refreshSequence = 0;
};

module.exports = {
  kGogAuthListTimeoutMs,
  kMaxDetectedGogAccounts,
  parseGogAuthList,
  refreshDetectedGogAccounts,
  getDetectedGogAccounts,
  resetDetectedGogAccountsForTests,
};
