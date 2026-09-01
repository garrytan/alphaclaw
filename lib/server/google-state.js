const crypto = require("crypto");
const { writeFileAtomic, withFileLockSync } = require("./utils/safe-file");

const kGoogleStateVersion = 2;
const kDefaultGoogleClient = "default";
const kDefaultGoogleScopes = [
  "gmail:read",
  "calendar:read",
  "calendar:write",
  "drive:read",
  "sheets:read",
  "docs:read",
];

const createEmptyGoogleState = () => ({
  version: kGoogleStateVersion,
  accounts: [],
  gmailPush: {
    token: "",
    topics: {},
  },
});

const createGoogleAccountId = () => crypto.randomBytes(4).toString("hex");

const normalizeScopes = (services) => {
  if (!Array.isArray(services)) return [...kDefaultGoogleScopes];
  const deduped = Array.from(
    new Set(
      services
        .map((scope) => String(scope || "").trim())
        .filter(Boolean),
    ),
  );
  return deduped.length ? deduped : [...kDefaultGoogleScopes];
};

const normalizePositiveInt = (value, fallbackValue = null) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackValue;
};

const normalizeTimestamp = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return null;
};

const normalizeGmailWatch = (gmailWatch = {}) => {
  const enabled = Boolean(gmailWatch?.enabled);
  return {
    enabled,
    port: enabled ? normalizePositiveInt(gmailWatch?.port) : null,
    expiration: normalizeTimestamp(gmailWatch?.expiration),
    lastPushAt: normalizeTimestamp(gmailWatch?.lastPushAt),
    pid: enabled ? normalizePositiveInt(gmailWatch?.pid) : null,
  };
};

const normalizeGmailPush = (gmailPush = {}) => {
  const rawTopics = gmailPush?.topics;
  const topics = Object.fromEntries(
    Object.entries(rawTopics && typeof rawTopics === "object" ? rawTopics : {})
      .map(([client, topic]) => [
        String(client || "").trim(),
        String(topic || "").trim(),
      ])
      .filter(([client, topic]) => client && topic),
  );
  return {
    token: String(gmailPush?.token || "").trim(),
    topics,
  };
};

const isLikelyPersonalEmail = (email = "") => {
  const normalized = String(email || "").trim().toLowerCase();
  return normalized.endsWith("@gmail.com") || normalized.endsWith("@googlemail.com");
};

const normalizePersonalFlag = ({ account = {}, client = kDefaultGoogleClient }) => {
  if (typeof account.personal === "boolean") return account.personal;
  if (client === "personal") return true;
  return isLikelyPersonalEmail(account.email);
};

const normalizeGoogleAccount = (account = {}) => ({
  // Backward-compatible migration path for older state entries that predate
  // explicit personal flags or were saved before the personal marker existed.
  ...(() => {
    const client =
      String(account.client || kDefaultGoogleClient).trim() || kDefaultGoogleClient;
    return {
      id: String(account.id || createGoogleAccountId()),
      email: String(account.email || "").trim(),
      client,
      personal: normalizePersonalFlag({ account, client }),
      services: normalizeScopes(account.services),
      authenticated: Boolean(account.authenticated),
      gmailWatch: normalizeGmailWatch(account.gmailWatch),
    };
  })(),
});

const normalizeGoogleStateV2 = (state = {}) => {
  const accounts = Array.isArray(state.accounts)
    ? state.accounts.map((account) => normalizeGoogleAccount(account))
    : [];
  return {
    version: kGoogleStateVersion,
    accounts,
    gmailPush: normalizeGmailPush(state.gmailPush),
  };
};

const hasPersonalGoogleAccount = (state = {}) =>
  (state.accounts || []).some((account) => account.personal);

const writeGoogleState = ({ fs, statePath, state }) => {
  const normalized = normalizeGoogleStateV2(state);
  // Atomic write under a lock (H11): a bare writeFileSync could leave truncated
  // JSON on a crash/ENOSPC, which the reader's catch turns into empty state,
  // and the next save then persists that empty state — losing every Google
  // account + the Gmail push token/topics.
  withFileLockSync(
    statePath,
    () => {
      writeFileAtomic(statePath, JSON.stringify(normalized, null, 2), {
        fsModule: fs,
      });
    },
    { fsModule: fs },
  );
  return normalized;
};

// Locked read-modify-write. writeGoogleState locks only the WRITE, so a
// read-then-write in one call site can still lose a concurrent writer's update
// (e.g. an OAuth-callback completion landing between a disconnect's readState()
// and saveState() — clobbering a freshly connected account, or resurrecting a
// removed one with a live token). This reads AND writes under one lock so
// interleaved mutations serialize. readGoogleState does its own normalization/
// migration writes via writeFileAtomic (not writeGoogleState), so it never
// re-acquires the lock — no reentrancy deadlock.
const updateGoogleState = ({ fs, statePath, mutator }) => {
  const runLocked = () => {
    const current = readGoogleState({ fs, statePath });
    const normalized = normalizeGoogleStateV2(mutator(current) ?? current);
    writeFileAtomic(statePath, JSON.stringify(normalized, null, 2), {
      fsModule: fs,
    });
    return normalized;
  };
  // Injected fs mocks without openSync can't lock (withFileLockSync no-ops
  // them too); run unserialized so tests keep working.
  if (typeof fs.openSync !== "function") return runLocked();
  let result;
  withFileLockSync(statePath, () => {
    result = runLocked();
  }, { fsModule: fs });
  return result;
};

const migrateGoogleStateV1 = ({ fs, statePath, rawState = {} }) => {
  const email = String(rawState.email || "").trim();
  const accounts = email
    ? [
        normalizeGoogleAccount({
          id: createGoogleAccountId(),
          email,
          services: rawState.services,
          authenticated: Boolean(rawState.authenticated),
          client: kDefaultGoogleClient,
          personal: false,
        }),
      ]
    : [];
  const migrated = {
    version: kGoogleStateVersion,
    accounts,
    gmailPush: normalizeGmailPush({}),
  };
  writeFileAtomic(statePath, JSON.stringify(migrated, null, 2), {
    fsModule: fs,
  });
  return migrated;
};

const readGoogleState = ({ fs, statePath }) => {
  if (!fs.existsSync(statePath)) return createEmptyGoogleState();
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    // Future-version guard (H11): a state file newer than this build (e.g. after
    // a release rollback) must be read best-effort and NEVER migrated-then-saved
    // — the old code funneled any version mismatch into migrateGoogleStateV1,
    // which immediately wrote a 0/1-account file, destroying newer accounts.
    if (raw && typeof raw.version === "number" && raw.version > kGoogleStateVersion) {
      return normalizeGoogleStateV2(raw);
    }
    if (raw && raw.version === kGoogleStateVersion && Array.isArray(raw.accounts)) {
      const normalized = normalizeGoogleStateV2(raw);
      if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
        writeFileAtomic(statePath, JSON.stringify(normalized, null, 2), {
          fsModule: fs,
        });
      }
      return normalized;
    }
    return migrateGoogleStateV1({ fs, statePath, rawState: raw || {} });
  } catch {
    return createEmptyGoogleState();
  }
};

const listGoogleAccounts = (state = {}) => [...(state.accounts || [])];

const getGoogleAccountById = (state = {}, accountId = "") =>
  (state.accounts || []).find((account) => account.id === accountId) || null;

const getGoogleAccountByEmailAndClient = (
  state = {},
  email = "",
  client = kDefaultGoogleClient,
) =>
  (state.accounts || []).find(
    (account) => account.email === email && account.client === client,
  ) || null;

const getGoogleAccountByEmail = (state = {}, email = "") => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;
  return (
    (state.accounts || []).find(
      (account) =>
        String(account.email || "").trim().toLowerCase() === normalizedEmail,
    ) || null
  );
};

const getGmailPushConfig = (state = {}) => normalizeGmailPush(state.gmailPush);

const setGmailPushConfig = ({ state = {}, config = {} }) => {
  const nextState = normalizeGoogleStateV2(state);
  nextState.gmailPush = normalizeGmailPush({
    ...nextState.gmailPush,
    ...config,
    topics: {
      ...(nextState.gmailPush?.topics || {}),
      ...((config?.topics && typeof config.topics === "object")
        ? config.topics
        : {}),
    },
  });
  return { state: nextState, gmailPush: nextState.gmailPush };
};

const getAccountGmailWatch = (account = {}) =>
  normalizeGmailWatch(account?.gmailWatch);

const setAccountGmailWatch = ({ state = {}, accountId = "", watch = {} }) => {
  const nextState = normalizeGoogleStateV2(state);
  const targetId = String(accountId || "").trim();
  if (!targetId) return { state: nextState, account: null };
  const accountIndex = nextState.accounts.findIndex(
    (account) => account.id === targetId,
  );
  if (accountIndex === -1) return { state: nextState, account: null };
  const account = nextState.accounts[accountIndex];
  const mergedWatch = normalizeGmailWatch({
    ...(account.gmailWatch || {}),
    ...watch,
  });
  const nextAccount = {
    ...account,
    gmailWatch: mergedWatch,
  };
  nextState.accounts[accountIndex] = nextAccount;
  return { state: nextState, account: nextAccount };
};

const listWatchEnabledAccounts = (state = {}) =>
  (state.accounts || []).filter((account) =>
    Boolean(normalizeGmailWatch(account.gmailWatch).enabled),
  );

const generatePushToken = () => crypto.randomBytes(24).toString("base64url");

const allocateServePort = ({
  state = {},
  basePort = 18801,
  maxAccounts = 5,
}) => {
  const usedPorts = new Set(
    (state.accounts || [])
      .map((account) => normalizePositiveInt(account?.gmailWatch?.port))
      .filter(Boolean),
  );
  for (let offset = 0; offset < maxAccounts; offset += 1) {
    const candidate = basePort + offset;
    if (!usedPorts.has(candidate)) return candidate;
  }
  return null;
};

const upsertGoogleAccount = ({
  state,
  account,
  maxAccounts = 5,
}) => {
  const nextState = normalizeGoogleStateV2(state);
  const normalized = normalizeGoogleAccount(account);
  if (!normalized.email) throw new Error("Account email is required");
  const existingIdx = nextState.accounts.findIndex((item) => item.id === normalized.id);

  if (normalized.personal) {
    const personalExists = nextState.accounts.some(
      (item, idx) => item.personal && idx !== existingIdx,
    );
    if (personalExists) {
      throw new Error("Only one personal account is allowed");
    }
  }

  if (existingIdx >= 0) {
    nextState.accounts[existingIdx] = normalized;
    return { state: nextState, account: normalized };
  }

  if (nextState.accounts.length >= maxAccounts) {
    throw new Error(`Maximum ${maxAccounts} Google accounts allowed`);
  }

  nextState.accounts.push(normalized);
  return { state: nextState, account: normalized };
};

const removeGoogleAccount = ({ state, accountId }) => {
  const nextState = normalizeGoogleStateV2(state);
  const removed = getGoogleAccountById(nextState, accountId);
  if (!removed) return { state: nextState, account: null };
  nextState.accounts = nextState.accounts.filter((account) => account.id !== accountId);
  return { state: nextState, account: removed };
};

module.exports = {
  kGoogleStateVersion,
  kDefaultGoogleClient,
  kDefaultGoogleScopes,
  createGoogleAccountId,
  createEmptyGoogleState,
  readGoogleState,
  writeGoogleState,
  updateGoogleState,
  listGoogleAccounts,
  getGoogleAccountById,
  getGoogleAccountByEmailAndClient,
  getGoogleAccountByEmail,
  upsertGoogleAccount,
  removeGoogleAccount,
  hasPersonalGoogleAccount,
  getGmailPushConfig,
  setGmailPushConfig,
  getAccountGmailWatch,
  setAccountGmailWatch,
  listWatchEnabledAccounts,
  generatePushToken,
  allocateServePort,
};
