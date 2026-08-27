const fs = require("fs");
const path = require("path");
const constants = require("./constants");

// Operators + notification-preference store.
//
// Lives in the non-git-synced state directory, NOT alphaclaw.json: operator
// names/emails/avatars and admin chat targets are PII, and alphaclaw.json is
// designed to be safe to commit. File mode is 0600.
//
//   {
//     operatorsVersion: 3,             // bumped on any operator removal —
//                                      // baked into session cookies so a
//                                      // removed operator's cookie stops
//                                      // resolving to that identity
//     operators: [{ id, name, email, avatar }],
//     notifications: {
//       preferredChannel: "telegram" | "slack" | "discord" | "whatsapp" | null,
//       adminTargets: [{ channel, target, accountId }],
//     },
//   }
const kOperatorsFileName = "operators.json";
const kManagedDirName = ".alphaclaw";
const kSupportedChannels = ["telegram", "slack", "discord", "whatsapp"];
const kOperatorIdPattern = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

const normalizeOperator = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim().toLowerCase();
  if (!kOperatorIdPattern.test(id)) return null;
  return {
    id,
    name: String(raw.name || "").trim().slice(0, 128) || id,
    email: String(raw.email || "").trim().slice(0, 256) || null,
    avatar: String(raw.avatar || "").trim().slice(0, 1024) || null,
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

const normalizeStore = (raw) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const operators = (Array.isArray(base.operators) ? base.operators : [])
    .map(normalizeOperator)
    .filter(Boolean);
  const seen = new Set();
  const deduped = operators.filter((op) => {
    if (seen.has(op.id)) return false;
    seen.add(op.id);
    return true;
  });
  const notifications =
    base.notifications && typeof base.notifications === "object"
      ? base.notifications
      : {};
  const preferredChannel = kSupportedChannels.includes(
    String(notifications.preferredChannel || "").toLowerCase(),
  )
    ? String(notifications.preferredChannel).toLowerCase()
    : null;
  return {
    operatorsVersion: Number.isInteger(base.operatorsVersion)
      ? base.operatorsVersion
      : 1,
    operators: deduped,
    notifications: {
      preferredChannel,
      adminTargets: (Array.isArray(notifications.adminTargets)
        ? notifications.adminTargets
        : []
      )
        .map(normalizeAdminTarget)
        .filter(Boolean),
    },
  };
};

const createOperatorsStore = ({
  fsModule = fs,
  openclawDir = constants.OPENCLAW_DIR,
  logger = console,
} = {}) => {
  const storePath = path.join(
    openclawDir,
    kManagedDirName,
    kOperatorsFileName,
  );

  const read = () => {
    try {
      return normalizeStore(
        JSON.parse(fsModule.readFileSync(storePath, "utf8")),
      );
    } catch {
      return normalizeStore({});
    }
  };

  const write = (store) => {
    const normalized = normalizeStore(store);
    const dir = path.dirname(storePath);
    fsModule.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.${kOperatorsFileName}.${process.pid}.tmp`,
    );
    fsModule.writeFileSync(
      tempPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      { mode: 0o600 },
    );
    try {
      fsModule.renameSync(tempPath, storePath);
    } catch (error) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
    try {
      fsModule.chmodSync(storePath, 0o600);
    } catch {}
    return normalized;
  };

  const update = (mutatorFn) => {
    const store = read();
    const next = typeof mutatorFn === "function" ? mutatorFn(store) : store;
    return write(next || store);
  };

  const setOperators = (operators) =>
    update((store) => {
      const next = (Array.isArray(operators) ? operators : [])
        .map(normalizeOperator)
        .filter(Boolean);
      const removed = store.operators.some(
        (existing) => !next.some((op) => op.id === existing.id),
      );
      store.operators = next;
      // Removal invalidates issued identities; additions don't need to.
      if (removed) store.operatorsVersion += 1;
      return store;
    });

  const getOperator = (id) =>
    read().operators.find((op) => op.id === String(id || "").toLowerCase()) ||
    null;

  const setNotificationPrefs = ({ preferredChannel, adminTargets } = {}) =>
    update((store) => {
      store.notifications = normalizeStore({
        notifications: { preferredChannel, adminTargets },
      }).notifications;
      return store;
    });

  return {
    storePath,
    read,
    update,
    setOperators,
    getOperator,
    setNotificationPrefs,
    kSupportedChannels,
  };
};

module.exports = { createOperatorsStore, kSupportedChannels };
