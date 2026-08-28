// Buzz channel setup (5.2): a resumable, server-persisted wizard state machine.
//
// Buzz is a beta-only EXTERNAL plugin: install @openclaw/buzz → restart →
// relay URL → the bot's public key is handed to a Buzz room owner → wait for
// Bot-role approval → pick rooms. The wizard must survive page reloads
// (upstream persists paused identities), so its state lives on disk, and
// Retry/Back NEVER touch the bot identity (C9) — identity generation and key
// storage are OpenClaw's, never AlphaClaw's. AlphaClaw never reads or writes
// privateKey material.
const { buildDevUpdateEnv } = require("./openclaw-channel-sync");
const { updateOpenclawConfig } = require("./openclaw-config");

const kBuzzStateFileName = "buzz-setup.json";
const kBuzzPluginSpec = "@openclaw/buzz";
const kInstallTimeoutMs = 5 * 60 * 1000;
const kBuzzStatuses = new Set([
  "idle",
  "installed",
  "awaiting-approval",
  "done",
]);
// Room ids are UUID-shaped canonical targets (documented Buzz limit).
const kRoomIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createBuzzSetup = ({
  openclawDir,
  stateStore,
  runStream,
  clawCmd,
  gatewayEnv = () => process.env,
  restartRequiredState = null,
  openclawCapabilities = null,
  nowFn = Date.now,
}) => {
  const readState = () => {
    const raw = stateStore.read();
    return {
      status: kBuzzStatuses.has(raw.status) ? raw.status : "idle",
      relayUrl: typeof raw.relayUrl === "string" ? raw.relayUrl : "",
      publicKey: typeof raw.publicKey === "string" ? raw.publicKey : "",
      lastProbeAt: Number(raw.lastProbeAt) || null,
      lastProbeDetail:
        typeof raw.lastProbeDetail === "string" ? raw.lastProbeDetail : "",
      startedAt: Number(raw.startedAt) || null,
    };
  };

  const writeState = (next) =>
    stateStore.update((current) => ({ ...current, ...next }));

  const markRestartRequired = (reason) => {
    try {
      restartRequiredState?.markRequired?.(reason);
    } catch {}
  };

  const getState = () => readState();

  const install = async () => {
    const result = await runStream.runStreamed({
      command: "openclaw",
      args: ["plugins", "install", kBuzzPluginSpec],
      // Plugin install executes external package code — same secret-free env
      // policy as overlay staging (E-C12).
      env: buildDevUpdateEnv(gatewayEnv()),
      timeoutMs: kInstallTimeoutMs,
      tailBytes: 64 * 1024,
    });
    if (!result.ok) {
      return {
        ok: false,
        code: "plugin_install_failed",
        message: "The Buzz plugin did not install.",
        hint: result.tail
          ? `OpenClaw said: ${String(result.tail).slice(-400)}`
          : "Check network access to the npm registry, then retry.",
      };
    }
    try {
      openclawCapabilities?.invalidate?.();
    } catch {}
    writeState({
      status: "installed",
      startedAt: readState().startedAt || nowFn(),
    });
    markRestartRequired("buzz_plugin_installed");
    return { ok: true, restartRequired: true };
  };

  const configure = ({ relayUrl, name = "Buzz" } = {}) => {
    const trimmed = String(relayUrl || "").trim();
    if (!/^wss:\/\/.+/i.test(trimmed)) {
      return {
        ok: false,
        code: "invalid_relay_url",
        message: "The relay URL must start with wss://",
        hint: "Your Buzz workspace admin can share the relay address.",
      };
    }
    updateOpenclawConfig({
      openclawDir,
      mutate: (cfg) => {
        const channels =
          cfg.channels && typeof cfg.channels === "object" ? cfg.channels : {};
        const buzz =
          channels.buzz && typeof channels.buzz === "object"
            ? channels.buzz
            : {};
        buzz.enabled = true;
        buzz.name = String(name || "Buzz").trim() || "Buzz";
        buzz.relayUrl = trimmed;
        channels.buzz = buzz;
        cfg.channels = channels;
      },
    });
    writeState({ status: "awaiting-approval", relayUrl: trimmed });
    markRestartRequired("buzz_relay_configured");
    return { ok: true, restartRequired: true };
  };

  // Poll the CLI for the bot identity / approval progress. Bounded and
  // read-only: retrying never rotates the generated identity.
  const probe = async () => {
    const result = await clawCmd("channels status --probe", {
      quiet: true,
      timeoutMs: 30_000,
    });
    const text = `${result?.stdout || ""}\n${result?.stderr || ""}`;
    const keyMatch = text.match(
      /(?:public[\s-]?key|publicKey)\s*[:=]\s*([A-Za-z0-9+/=_-]{16,})/i,
    );
    const buzzSection = /buzz/i.test(text);
    const connected = buzzSection && /connected|approved|ready/i.test(text);
    const nextState = {
      lastProbeAt: nowFn(),
      lastProbeDetail: buzzSection
        ? connected
          ? "Buzz reports the bot as approved."
          : "Waiting for a room owner to approve the bot."
        : "Buzz did not report status yet — it may need the gateway restart.",
      ...(keyMatch ? { publicKey: keyMatch[1] } : {}),
    };
    writeState(nextState);
    return {
      ok: result?.ok !== false,
      connected,
      publicKey: nextState.publicKey || readState().publicKey || "",
      detail: nextState.lastProbeDetail,
    };
  };

  const rooms = ({ groups = [], defaultTo = "" } = {}) => {
    const normalized = (Array.isArray(groups) ? groups : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    if (normalized.length === 0) {
      return {
        ok: false,
        code: "no_rooms",
        message: "Pick at least one room.",
      };
    }
    const invalid = normalized.find((id) => !kRoomIdPattern.test(id));
    if (invalid) {
      return {
        ok: false,
        code: "invalid_room_id",
        message: `"${invalid}" is not a room UUID.`,
        hint: "Buzz rooms are addressed by UUID — copy it from the room's settings.",
      };
    }
    const normalizedDefault = String(defaultTo || "").trim() || normalized[0];
    if (!normalized.includes(normalizedDefault)) {
      return {
        ok: false,
        code: "invalid_default_room",
        message: "The default outbound room must be one of the selected rooms.",
      };
    }
    updateOpenclawConfig({
      openclawDir,
      mutate: (cfg) => {
        const channels =
          cfg.channels && typeof cfg.channels === "object" ? cfg.channels : {};
        const buzz =
          channels.buzz && typeof channels.buzz === "object"
            ? channels.buzz
            : {};
        buzz.groups = normalized;
        buzz.defaultTo = normalizedDefault;
        channels.buzz = buzz;
        cfg.channels = channels;
      },
    });
    writeState({ status: "done" });
    markRestartRequired("buzz_rooms_configured");
    return { ok: true, restartRequired: true };
  };

  // Cancel pauses the flow. The plugin and any generated identity stay
  // installed (upstream persists paused identities) — the UI copy says so.
  const cancel = () => {
    writeState({ status: "idle" });
    return { ok: true };
  };

  return { getState, install, configure, probe, rooms, cancel };
};

module.exports = { createBuzzSetup, kBuzzStateFileName, kBuzzPluginSpec };
