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
  // Transition facade (team-service.js): snapshot -> write -> restart ->
  // probe -> auto-restore, plus the cached identity-handshake probe.
  teamService = null,
  presence,
  readTeamSettings,
  updateTeamSettings,
  restartRequiredState = null,
  openclawCapabilities = null,
  insertWatchdogEvent = () => {},
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
  // needs a gateway restart to take effect. (Enable/disable go through the
  // teamService transition instead, which restarts + probes inline.)
  //
  // Gate the gateway write on team mode being ON (H1): while team is off the
  // gateway is in single-user auth, and rewriting gateway.auth to
  // trusted-proxy here (e.g. an admin disabling a leftover member) would flip
  // the gateway into a mode with no identity injection on the next restart —
  // the exact split-brain the boot divergence detector only warns about.
  // Returns true when it actually rewrote the gateway config (team on), so
  // callers report restart-required honestly.
  const reconcile = async (reason) => {
    if (readTeamSettings()?.enabled !== true) return false;
    // F5/documented model: the gateway captures gateway.auth at startup, so a
    // role/scope change only takes GATEWAY effect on the next restart
    // (markRestartRequired surfaces it). AlphaClaw-side authority (token
    // rotation, presence, role in the DB) updated in the caller already.
    await teamGatewayConfig.applyTeamGatewayConfig();
    markRestartRequired(reason);
    try {
      teamService?.invalidateIdentityProbe?.();
    } catch {}
    return true;
  };

  const teamCapability = async () => {
    try {
      const capabilities = await openclawCapabilities?.getAll?.();
      return capabilities?.trustedProxyTeam !== false;
    } catch {
      return true;
    }
  };

  const inviteUrlFor = (req, token) => {
    const configured = String(resolveSetupUrl() || "").replace(/\/+$/, "");
    // Prefer an explicitly configured public URL; the localhost default is
    // only right when it matches how this request actually arrived.
    const base =
      configured && !/^https?:\/\/localhost(:|\/|$)/i.test(configured)
        ? configured
        : `${req.protocol}://${req.get("host")}`;
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
      // Cached loopback identity-handshake result (null while team is off):
      // the Team page renders a failure banner when the gateway stops
      // honoring the injected identity.
      try {
        body.identityProbe = (await teamService?.getIdentityProbe?.()) ?? null;
      } catch {
        body.identityProbe = null;
      }
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
      // D11: never arm the legacy-login lockdown against an unverified
      // credential — prove the STORED hash authenticates before anything can
      // disable the shared password. A failure here rolls the account back.
      const verified = membersStore.verifyMemberPassword({
        email: ownerEmail,
        password: ownerPassword,
      });
      if (!verified) {
        try {
          membersStore.removeMember(owner.id);
        } catch {}
        return res.status(500).json({
          ok: false,
          code: "owner_verify_failed",
          error:
            "The owner account was created but its password did not verify — nothing was enabled. Try again.",
        });
      }
    }
    // Full transition (snapshot -> write from roster -> restart -> identity
    // probe): the flag flips on only after the gateway VERIFIED the injected
    // identity; a failed probe auto-restores the previous auth config and
    // restarts again, so a broken flip never strands the gateway.
    const result = await teamService.setEnabled(true);
    if (!result.ok) {
      const status = result.code === "transition_in_flight" ? 409 : 502;
      return res.status(status).json({
        ok: false,
        code: result.code || "team_enable_failed",
        restored: result.restored !== false,
        error:
          result.error ||
          "Could not enable team access — the previous gateway auth was restored.",
      });
    }
    // D11: the lockdown arms only after the owner credential VERIFIED above
    // AND the identity handshake succeeded.
    updateTeamSettings({ disableLegacyLogin: disableLegacyLogin === true });
    audit("team_enabled", {
      owner: owner.email,
      disableLegacyLogin: disableLegacyLogin === true,
    });
    res.json({
      ok: true,
      owner: { email: owner.email, role: owner.role },
      // The transition already restarted the gateway and verified the
      // handshake — no restart-required banner.
      restartRequired: false,
    });
  });

  app.post("/api/team/disable", requireAdmin, async (req, res) => {
    if (readTeamSettings().enabled !== true) {
      return res
        .status(409)
        .json({ ok: false, code: "not_enabled", error: "Team access is not enabled." });
    }
    // Transition restore: snapshot back -> restart -> shared-secret probe.
    // The flag always lands on off (a failed probe is reported, not stuck).
    const result = await teamService.setEnabled(false);
    if (!result.ok && result.code === "transition_in_flight") {
      return res.status(409).json({
        ok: false,
        code: result.code,
        error: result.error,
      });
    }
    updateTeamSettings({ disableLegacyLogin: false });
    // Member sessions must not outlive team mode: rotate every member's
    // token secret so outstanding v2 cookies die. Accounts are kept for a
    // future re-enable; the owner signs in with the shared password again.
    for (const member of membersStore.listMembers()) {
      membersStore.rotateTokenSecret(member.id);
      presence.remove(member.email);
    }
    audit("team_disabled", { probeOk: result.ok === true });
    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        code: "gateway_probe_failed",
        disabled: true,
        error:
          result.error ||
          "Team access is off, but the gateway did not verify its restored auth — check the Watchdog page.",
      });
    }
    res.json({ ok: true, restartRequired: false });
  });

  app.post("/api/team/invites", requireAdmin, (req, res) => {
    const { email = null, role = "member" } = req.body || {};
    if (!kInviteRoleValues.has(role)) {
      return res
        .status(400)
        .json({ ok: false, error: "role must be admin or member" });
    }
    let invite;
    try {
      invite = membersStore.createInvite({
        email: email || null,
        role,
        createdBy: req.alphaclawIdentity?.email || "owner",
      });
    } catch (err) {
      // A malformed pinned email is a client error, not a 500.
      return res.status(400).json({
        ok: false,
        code: err?.code || "invite_create_failed",
        error: err?.message || "Could not create the invite",
      });
    }
    audit("team_invite_created", { role, email: email || null });
    const { token, ...meta } = invite;
    res.json({ ok: true, invite: meta, token, url: inviteUrlFor(req, token) });
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
    let reconciled;
    try {
      reconciled = await reconcile("team_member_changed");
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
    res.json({ ok: true, member, restartRequired: reconciled });
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
    let reconciled;
    try {
      reconciled = await reconcile("team_member_removed");
    } catch (err) {
      return res.status(500).json({
        ok: false,
        code: "gateway_config_failed",
        error: err?.message || "Member removed, but the gateway config rebuild failed",
      });
    }
    audit("team_member_removed", { memberId: member.id, email: member.email });
    res.json({ ok: true, restartRequired: reconciled });
  });
};

module.exports = { registerTeamRoutes };
