// Team mode routes (4.5). Mounted under /api/team — the auth matrix lets
// members GET here (presence, roster); every mutation is requireAdmin.
// All mutations are audit-logged through the watchdog event log (CEO 10)
// and re-reconcile the gateway auth config from the current roster (E-C8).

const kInviteRoleValues = new Set(["admin", "member"]);

const registerTeamRoutes = ({
  app,
  requireAdmin,
  membersStore,
  teamGatewayConfig,
  teamStateStore,
  presence,
  readTeamSettings,
  updateTeamSettings,
  restartRequiredState = null,
  openclawCapabilities = null,
  insertWatchdogEvent = () => {},
  invalidateTeamActiveCache = () => {},
  resolveSetupUrl = () => "",
}) => {
  const audit = (eventType, details) => {
    try {
      insertWatchdogEvent({
        eventType,
        source: "team",
        status: "info",
        details,
      });
    } catch {}
  };

  const markRestartRequired = (reason) => {
    try {
      restartRequiredState?.markRequired?.(reason);
    } catch {}
  };

  // Gateway auth is captured at startup — every roster-driven config change
  // needs a gateway restart to take effect.
  const reconcile = async (reason) => {
    await teamGatewayConfig.applyTeamGatewayConfig();
    markRestartRequired(reason);
  };

  const teamCapability = async () => {
    try {
      const capabilities = await openclawCapabilities?.getAll?.();
      return capabilities?.trustedProxyTeam !== false;
    } catch {
      return true;
    }
  };

  const inviteUrlFor = (token) => {
    const base = String(resolveSetupUrl() || "").replace(/\/+$/, "");
    return `${base}/login.html?invite=${encodeURIComponent(token)}`;
  };

  app.get("/api/team", async (req, res) => {
    const settings = readTeamSettings();
    const identity = req.alphaclawIdentity || null;
    const isAdmin = identity?.role === "admin";
    const body = {
      ok: true,
      enabled: settings.enabled === true,
      disableLegacyLogin: settings.disableLegacyLogin === true,
      presence: presence.list(),
      me: identity
        ? {
            kind: identity.kind,
            role: identity.role,
            email: identity.email,
            displayName: identity.displayName || null,
          }
        : null,
    };
    if (isAdmin) {
      body.members = membersStore.listMembers();
      body.invites = membersStore.listInvites();
      body.capability = { trustedProxyTeam: await teamCapability() };
      body.state = {
        enabledAt: teamStateStore.read().enabledAt || null,
      };
    } else {
      // Members see the roster without account states — enough for "who's here".
      body.members = membersStore
        .listMembers()
        .filter((member) => !member.disabled)
        .map((member) => ({
          email: member.email,
          displayName: member.displayName,
          role: member.role,
        }));
    }
    res.json(body);
  });

  app.get("/api/team/presence", (req, res) => {
    res.json({ ok: true, presence: presence.list(), ttlMs: presence.ttlMs });
  });

  app.post("/api/team/enable", requireAdmin, async (req, res) => {
    const {
      ownerEmail = "",
      ownerPassword = "",
      ownerDisplayName = "",
      disableLegacyLogin = false,
      confirmHostIsolation = false,
    } = req.body || {};
    if (readTeamSettings().enabled === true) {
      return res
        .status(409)
        .json({ ok: false, code: "already_enabled", error: "Team access is already enabled." });
    }
    if (!(await teamCapability())) {
      return res.status(409).json({
        ok: false,
        code: "capability_missing",
        error:
          "Team access needs OpenClaw 2026.8 or newer. Switch to the beta channel on the Upgrade page first.",
      });
    }
    // D8/E-C3: shared access over loopback is a convenience boundary — any
    // process on this host could impersonate a member. Enablement is BLOCKED
    // until the admin explicitly confirms the host-isolation prerequisite.
    if (confirmHostIsolation !== true) {
      return res.status(400).json({
        ok: false,
        code: "host_isolation_unconfirmed",
        error:
          "Confirm the host-isolation prerequisite: this host must not run untrusted processes (loopback firewalled or Tailscale-fronted).",
      });
    }
    let owner = membersStore.getMemberByEmail(ownerEmail);
    if (owner) {
      // Re-enable with an existing owner account: verify the password instead
      // of failing on email_taken.
      const verified = membersStore.verifyMemberPassword({
        email: ownerEmail,
        password: ownerPassword,
      });
      if (!verified || verified.role !== "admin") {
        return res.status(401).json({
          ok: false,
          code: "owner_verify_failed",
          error: "That email exists but the password does not match an admin account.",
        });
      }
      owner = verified;
    } else {
      try {
        owner = membersStore.createMember({
          email: ownerEmail,
          displayName: ownerDisplayName,
          role: "admin",
          password: ownerPassword,
        });
      } catch (err) {
        return res.status(400).json({
          ok: false,
          code: err?.code || "owner_create_failed",
          error: err?.message || "Could not create the owner account",
        });
      }
    }
    updateTeamSettings({
      enabled: true,
      // D11: the lockdown only arms alongside a just-verified owner account.
      disableLegacyLogin: disableLegacyLogin === true,
    });
    invalidateTeamActiveCache();
    let applied;
    try {
      applied = await teamGatewayConfig.applyTeamGatewayConfig();
    } catch (err) {
      // Roll the flag back — a half-enabled team (flag on, gateway auth
      // unchanged) would inject identities the gateway rejects.
      updateTeamSettings({ enabled: false, disableLegacyLogin: false });
      invalidateTeamActiveCache();
      return res.status(500).json({
        ok: false,
        code: "gateway_config_failed",
        error: err?.message || "Could not write the gateway auth config",
      });
    }
    markRestartRequired("team_enabled");
    audit("team_enabled", {
      owner: owner.email,
      disableLegacyLogin: disableLegacyLogin === true,
    });
    res.json({
      ok: true,
      owner: { email: owner.email, role: owner.role },
      auth: applied.auth,
      restartRequired: true,
    });
  });

  app.post("/api/team/disable", requireAdmin, async (req, res) => {
    if (readTeamSettings().enabled !== true) {
      return res
        .status(409)
        .json({ ok: false, code: "not_enabled", error: "Team access is not enabled." });
    }
    const restored = teamGatewayConfig.revertTeamGatewayConfig();
    updateTeamSettings({ enabled: false, disableLegacyLogin: false });
    invalidateTeamActiveCache();
    // Member sessions must not outlive team mode: rotate every member's
    // token secret so outstanding v2 cookies die. Accounts are kept for a
    // future re-enable; the owner signs in with the shared password again.
    for (const member of membersStore.listMembers()) {
      membersStore.rotateTokenSecret(member.id);
      presence.remove(member.email);
    }
    markRestartRequired("team_disabled");
    audit("team_disabled", { restoredAuth: restored.restored !== null });
    res.json({ ok: true, restartRequired: true });
  });

  app.post("/api/team/invites", requireAdmin, (req, res) => {
    const { email = null, role = "member" } = req.body || {};
    if (!kInviteRoleValues.has(role)) {
      return res
        .status(400)
        .json({ ok: false, error: "role must be admin or member" });
    }
    const invite = membersStore.createInvite({
      email: email || null,
      role,
      createdBy: req.alphaclawIdentity?.email || "owner",
    });
    audit("team_invite_created", { role, email: email || null });
    const { token, ...meta } = invite;
    res.json({ ok: true, invite: meta, token, url: inviteUrlFor(token) });
  });

  app.delete("/api/team/invites/:id", requireAdmin, (req, res) => {
    const removed = membersStore.deleteInvite(req.params.id);
    if (!removed) {
      return res.status(404).json({ ok: false, error: "Invite not found" });
    }
    audit("team_invite_revoked", { inviteId: req.params.id });
    res.json({ ok: true });
  });

  app.patch("/api/team/members/:id", requireAdmin, async (req, res) => {
    const { role, displayName, disabled } = req.body || {};
    if (role !== undefined && !kInviteRoleValues.has(role)) {
      return res
        .status(400)
        .json({ ok: false, error: "role must be admin or member" });
    }
    let member;
    try {
      member = membersStore.updateMember({
        memberId: req.params.id,
        role,
        displayName,
        disabled,
      });
    } catch (err) {
      return res
        .status(err?.code === "last_admin" ? 409 : err?.code === "member_not_found" ? 404 : 400)
        .json({ ok: false, code: err?.code || "update_failed", error: err?.message });
    }
    // Authority changes revoke sessions and gateway access in one transaction-
    // shaped flow: rotate secret, drop presence, rebuild gateway config.
    if (role !== undefined || disabled !== undefined) {
      membersStore.rotateTokenSecret(member.id);
      presence.remove(member.email);
    }
    try {
      await reconcile("team_member_changed");
    } catch (err) {
      return res.status(500).json({
        ok: false,
        code: "gateway_config_failed",
        error: err?.message || "Member updated, but the gateway config rebuild failed",
      });
    }
    audit("team_member_updated", {
      memberId: member.id,
      email: member.email,
      role: member.role,
      disabled: member.disabled,
    });
    res.json({ ok: true, member, restartRequired: true });
  });

  app.delete("/api/team/members/:id", requireAdmin, async (req, res) => {
    const member = membersStore.getMember(req.params.id);
    if (!member) {
      return res.status(404).json({ ok: false, error: "Member not found" });
    }
    try {
      membersStore.removeMember(member.id);
    } catch (err) {
      return res
        .status(err?.code === "last_admin" ? 409 : 400)
        .json({ ok: false, code: err?.code || "remove_failed", error: err?.message });
    }
    presence.remove(member.email);
    try {
      await reconcile("team_member_removed");
    } catch (err) {
      return res.status(500).json({
        ok: false,
        code: "gateway_config_failed",
        error: err?.message || "Member removed, but the gateway config rebuild failed",
      });
    }
    audit("team_member_removed", { memberId: member.id, email: member.email });
    res.json({ ok: true, restartRequired: true });
  });
};

module.exports = { registerTeamRoutes };
