// Guided ClickClack account setup (setup code or setup URL), split out of
// createChannelsDomain with the same dependencies.
const {
  shellEscapeArg,
  loadConfig,
  saveConfig,
  ensurePluginAllowed,
  normalizeBindingMatch,
  buildBindingSpec,
  withNormalizedAgentsConfig,
} = require("../shared");
const { resolveChannelCmdTimeoutMs } = require("../../constants");

const createClickclackChannelSetup = ({
  fsImpl,
  OPENCLAW_DIR,
  clawCmd,
  gatewayEnv,
  runStream,
  restartSavedChannel,
}) => {
  // D15: the setup value never reaches logs, errors, or the client — scrub it
  // from any CLI output before surfacing.
  const scrubSetupValue = (text, setupValue) =>
    String(text || "").split(setupValue).join("[setup code]");

  const createClickclackGuidedAccount = async ({
    setupValue,
    agentId,
    accountId,
    name,
    onProgress = () => {},
  }) => {
    onProgress({ phase: "configuring", label: "Verifying setup code..." });
    // Enable the plugin first, mirroring the manual path.
    const pluginCfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });
    ensurePluginAllowed({ cfg: pluginCfg, pluginKey: "clickclack" });
    saveConfig({ fsImpl, OPENCLAW_DIR, config: pluginCfg });

    const args = [
      "channels",
      "add",
      "--channel",
      "clickclack",
      ...(accountId !== "default" ? ["--account", accountId] : []),
      ...(name ? ["--name", name] : []),
      // `--code` takes the one-time setup code OR the setup URL (2026.9.8 and
      // 2026.10.2 help: "ClickClack one-time setup code or setup URL"). There
      // is no `--url`: both reject it with `OpenClaw does not recognize
      // option "--url".`
      "--code",
      setupValue,
    ];
    const result = await runStream.runStreamed({
      command: "openclaw",
      args,
      env: gatewayEnv(),
      timeoutMs: resolveChannelCmdTimeoutMs(),
      tailBytes: 64 * 1024,
    });
    if (!result.ok) {
      const tail = scrubSetupValue(result.tail, setupValue);
      if (
        /unknown option|unknown argument|unexpected argument|does not recognize option/i.test(
          tail,
        )
      ) {
        throw new Error(
          "This OpenClaw build does not accept ClickClack setup codes. Use the manual token fields below.",
        );
      }
      if (/expired|invalid|already used/i.test(tail)) {
        throw new Error(
          "ClickClack rejected the setup code. Codes are single-use and expire in 10 minutes — generate a fresh one in ClickClack and paste it straight in.",
        );
      }
      throw new Error(
        `ClickClack setup did not complete.${tail ? ` OpenClaw said: ${tail.slice(-400)}` : ""}`,
      );
    }

    // The CLI wrote the account config (credential included). Bind the agent
    // and finish like the manual path. Anything AFTER `channels add` succeeds
    // must roll the just-created account back on failure: the setup code is
    // single-use and already spent, so a leftover account would block a clean
    // retry (which needs a fresh code) — mirror the manual path's cleanup.
    let restartOutcome = {};
    try {
      onProgress({ phase: "binding", label: "Binding agent..." });
      const bindSpec = buildBindingSpec({ provider: "clickclack", accountId });
      const bindResult = await clawCmd(
        `agents bind --agent ${shellEscapeArg(agentId)} --bind ${shellEscapeArg(bindSpec)}`,
        { quiet: true, timeoutMs: resolveChannelCmdTimeoutMs() },
      );
      if (!bindResult?.ok) {
        throw new Error(
          scrubSetupValue(
            bindResult?.stderr || bindResult?.stdout || "Could not bind channel account",
            setupValue,
          ),
        );
      }
      onProgress({ phase: "restarting", label: "Rebooting..." });
      restartOutcome = await restartSavedChannel();
    } catch (error) {
      try {
        await clawCmd(
          [
            "channels remove",
            "--channel clickclack",
            accountId !== "default"
              ? `--account ${shellEscapeArg(accountId)}`
              : "",
            "--delete",
          ]
            .filter(Boolean)
            .join(" "),
          { quiet: true, timeoutMs: resolveChannelCmdTimeoutMs() },
        );
      } catch {}
      throw error;
    }
    return {
      ...restartOutcome,
      channel: "clickclack",
      account: { id: accountId, name, envKey: null },
      binding: {
        agentId,
        match: normalizeBindingMatch({ channel: "clickclack", accountId }),
      },
    };
  };

  return { createClickclackGuidedAccount };
};

module.exports = { createClickclackChannelSetup };
