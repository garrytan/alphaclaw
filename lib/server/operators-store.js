const fs = require("fs");
const path = require("path");
const { OPENCLAW_DIR } = require("./constants");
const { buildManagedPaths } = require("./internal-files-migration");
const { withFileLockSync } = require("./utils/safe-file");

// Operators + notification-preference store.
//
// One 0600 file in the non-git-synced state dir holds both the named-operator
// list (team mode) and the update-notification routing preferences — operator
// names/emails and admin chat targets are PII and must never land in the
// committable alphaclaw.json.
const kOperatorsFileName = "team-operators.json";
// Operator ids double as gateway `allowUsers` entries and travel in an HTTP
// header, so they must stay header-safe and shell-boring.
const kOperatorIdPattern = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const kMaxOperators = 50;
const kOperatorsFileMode = 0o600;
const kSupportedChannels = ["telegram", "slack", "discord", "whatsapp"];

const resolveOperatorsPath = ({ openclawDir = OPENCLAW_DIR } = {}) =>
  path.join(buildManagedPaths({ openclawDir }).internalDir, kOperatorsFileName);

const isValidOperatorId = (value) =>
  typeof value === "string" && kOperatorIdPattern.test(value);

const normalizeOperator = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = String(raw.id || "").trim();
  if (!isValidOperatorId(id)) return null;
  return {
    id,
    name: String(raw.name || "").trim().slice(0, 200),
    email: String(raw.email || "").trim().slice(0, 320),
    avatar: String(raw.avatar || "").trim().slice(0, 2000),
  };
};

const normalizeAdminTarget = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const channel = String(raw.channel || "").trim().toLowerCase();
  const target = String(raw.target || "").trim();
  if (!kSupportedChannels.includes(channel) || !target) return null;
  return {
    channel,
    target: target.slice(0, 256),
    accountId:
      String(raw.accountId || "").trim().toLowerCase().slice(0, 64) || null,
  };
};

const normalizeNotifications = (raw) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const preferredChannel = kSupportedChannels.includes(
    String(base.preferredChannel || "").toLowerCase(),
  )
    ? String(base.preferredChannel).toLowerCase()
    : null;
  return {
    preferredChannel,
    adminTargets: (Array.isArray(base.adminTargets) ? base.adminTargets : [])
      .map(normalizeAdminTarget)
      .filter(Boolean),
  };
};

const normalizeOperatorsState = (raw = {}) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seen = new Set();
  const operators = (Array.isArray(base.operators) ? base.operators : [])
    .map(normalizeOperator)
    .filter((operator) => {
      if (!operator || seen.has(operator.id)) return false;
      seen.add(operator.id);
      return true;
    })
    .slice(0, kMaxOperators);
  const version = Number(base.operatorsVersion);
  return {
    version: 1,
    operators,
    operatorsVersion: Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1,
    // Notification prefs ride the same normalized state so an operators write
    // can never silently wipe them.
    notifications: normalizeNotifications(base.notifications),
  };
};

const readOperatorsState = ({ fsModule = fs, openclawDir = OPENCLAW_DIR } = {}) => {
  try {
    const raw = fsModule.readFileSync(resolveOperatorsPath({ openclawDir }), "utf8");
    return normalizeOperatorsState(JSON.parse(raw));
  } catch {
    return normalizeOperatorsState({});
  }
};

// Operator identity is not a security boundary, but emails still don't belong
// world-readable in a shared state dir: 0600, atomic-ish write under lock.
const writeOperatorsState = ({ fsModule = fs, openclawDir = OPENCLAW_DIR, state }) => {
  const filePath = resolveOperatorsPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeOperatorsState(state);
  fsModule.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: kOperatorsFileMode,
  });
  try {
    fsModule.chmodSync(filePath, kOperatorsFileMode);
  } catch {}
  return normalized;
};

const listOperators = (options = {}) => readOperatorsState(options).operators;

const getOperatorsVersion = (options = {}) =>
  readOperatorsState(options).operatorsVersion;

const getOperatorById = (operatorId, options = {}) => {
  const id = String(operatorId || "").trim();
  if (!id) return null;
  return listOperators(options).find((operator) => operator.id === id) || null;
};

// Replaces the operator list. operatorsVersion bumps only when an existing
// operator id disappears: removal must invalidate the operator binding of
// outstanding cookies, while add/edit must not (see auth downgrade rules).
const setOperators = ({ fsModule = fs, openclawDir = OPENCLAW_DIR, operators } = {}) => {
  const filePath = resolveOperatorsPath({ openclawDir });
  return withFileLockSync(
    filePath,
    () => {
      const current = readOperatorsState({ fsModule, openclawDir });
      const next = normalizeOperatorsState({
        operators,
        operatorsVersion: current.operatorsVersion,
        notifications: current.notifications,
      });
      const nextIds = new Set(next.operators.map((operator) => operator.id));
      const removed = current.operators.some(
        (operator) => !nextIds.has(operator.id),
      );
      if (removed) next.operatorsVersion = current.operatorsVersion + 1;
      return writeOperatorsState({ fsModule, openclawDir, state: next });
    },
    { fsModule },
  );
};

const setNotificationPrefs = ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  preferredChannel = null,
  adminTargets = [],
} = {}) => {
  const filePath = resolveOperatorsPath({ openclawDir });
  return withFileLockSync(
    filePath,
    () => {
      const current = readOperatorsState({ fsModule, openclawDir });
      current.notifications = normalizeNotifications({
        preferredChannel,
        adminTargets,
      });
      return writeOperatorsState({ fsModule, openclawDir, state: current });
    },
    { fsModule },
  );
};

// Instance-style facade used by the notification routing layer (server.js,
// upgrade-notifier, the notifications routes). Same file, same functions.
const createOperatorsStore = ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
} = {}) => ({
  storePath: resolveOperatorsPath({ openclawDir }),
  read: () => readOperatorsState({ fsModule, openclawDir }),
  setOperators: (operators) => setOperators({ fsModule, openclawDir, operators }),
  getOperator: (operatorId) =>
    getOperatorById(operatorId, { fsModule, openclawDir }),
  setNotificationPrefs: ({ preferredChannel, adminTargets } = {}) =>
    setNotificationPrefs({ fsModule, openclawDir, preferredChannel, adminTargets }),
  kSupportedChannels,
});

module.exports = {
  kOperatorIdPattern,
  kMaxOperators,
  kSupportedChannels,
  createOperatorsStore,
  getOperatorById,
  getOperatorsVersion,
  isValidOperatorId,
  listOperators,
  normalizeOperator,
  normalizeOperatorsState,
  readOperatorsState,
  resolveOperatorsPath,
  setNotificationPrefs,
  setOperators,
};
