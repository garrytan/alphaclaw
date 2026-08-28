const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  initAuthDb,
  closeAuthDb,
  getAuthDb,
} = require("../../lib/server/db/auth");
const { createMembersStore } = require("../../lib/server/db/auth/members");

describe("server/db/auth members store (4.1)", () => {
  let rootDir;
  let store;
  let now;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-members-"));
    initAuthDb({ rootDir });
    now = 1_000_000;
    store = createMembersStore({ getDb: getAuthDb, nowFn: () => now });
  });

  afterEach(() => {
    closeAuthDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const createOwner = () =>
    store.createMember({
      email: "Owner@Example.com",
      displayName: "Owner",
      role: "admin",
      password: "correct horse battery",
    });

  it("creates members with normalized email and verifies passwords via scrypt", () => {
    const owner = createOwner();
    expect(owner.email).toBe("owner@example.com");
    expect(owner.role).toBe("admin");
    expect(owner.disabled).toBe(false);

    // Password rows never leave the store.
    expect(owner.passwordHash).toBeUndefined();
    expect(owner.tokenSecret).toBeUndefined();

    expect(
      store.verifyMemberPassword({
        email: "OWNER@example.COM",
        password: "correct horse battery",
      }),
    ).toEqual(expect.objectContaining({ id: owner.id }));
    expect(
      store.verifyMemberPassword({
        email: "owner@example.com",
        password: "wrong",
      }),
    ).toBeNull();
  });

  it("rejects duplicate emails (case-insensitive), bad emails, weak passwords", () => {
    createOwner();
    expect(() =>
      store.createMember({
        email: "owner@EXAMPLE.com",
        role: "member",
        password: "another password",
      }),
    ).toThrow(expect.objectContaining({ code: "email_taken" }));
    expect(() =>
      store.createMember({ email: "not-an-email", password: "long enough pw" }),
    ).toThrow(expect.objectContaining({ code: "invalid_email" }));
    expect(() =>
      store.createMember({ email: "a@b.co", password: "short" }),
    ).toThrow(expect.objectContaining({ code: "weak_password" }));
  });

  it("rejects header/config-injection emails at createMember and createInvite (H2)", () => {
    const owner = createOwner();
    const nasty = [
      "a@b.co\r\nx-alphaclaw-user: admin@evil", // CRLF header injection
      "a b@c.co", // whitespace
      "no-domain@", // empty domain
      "@no-local.co", // empty local
      "a@bco", // no dotted domain
      `${"x".repeat(250)}@example.com`, // over length cap
    ];
    for (const email of nasty) {
      expect(() =>
        store.createMember({ email, password: "long enough pw" }),
      ).toThrow(expect.objectContaining({ code: "invalid_email" }));
      expect(() =>
        store.createInvite({ email, createdBy: owner.id }),
      ).toThrow(expect.objectContaining({ code: "invalid_email" }));
    }
  });

  it("acceptInvite validates the token before any email check (no enumeration oracle, H3)", () => {
    createOwner();
    // A bad token returns invite_invalid even when the email is already taken —
    // an unauthenticated caller cannot distinguish taken vs free emails.
    const res = store.acceptInvite({
      token: "no-such-token",
      providedEmail: "owner@example.com",
      password: "long enough pw",
    });
    expect(res).toEqual({ ok: false, code: "invite_invalid" });
  });

  it("acceptInvite does not burn the single-use invite when member creation fails (F9/H4)", () => {
    const owner = createOwner();
    // Pin the invite to an email that is already taken → create must fail, and
    // the invite must remain usable.
    const invite = store.createInvite({
      email: "owner@example.com",
      createdBy: owner.id,
    });
    const first = store.acceptInvite({
      token: invite.token,
      password: "long enough pw",
    });
    expect(first).toEqual(expect.objectContaining({ ok: false, code: "email_taken" }));
    // The token is NOT consumed — a later accept with a free email still works.
    const second = store.acceptInvite({
      token: invite.token,
      providedEmail: "new@example.com",
      password: "long enough pw",
    });
    // Pinned email is authoritative, so the still-taken pin wins again — the
    // point is the token survived the first failure (not consumed).
    expect(second.code).toBe("email_taken");
    expect(store.getMemberByEmail("new@example.com")).toBeNull();
  });

  it("acceptInvite consumes the invite and creates the member on success (F9)", () => {
    const owner = createOwner();
    const invite = store.createInvite({ role: "member", createdBy: owner.id });
    const res = store.acceptInvite({
      token: invite.token,
      providedEmail: "teammate@example.com",
      password: "long enough pw",
    });
    expect(res.ok).toBe(true);
    expect(res.member.email).toBe("teammate@example.com");
    expect(res.member.role).toBe("member");
    // Single-use: a second accept with the same token is rejected.
    const again = store.acceptInvite({
      token: invite.token,
      providedEmail: "other@example.com",
      password: "long enough pw",
    });
    expect(again).toEqual({ ok: false, code: "invite_invalid" });
  });

  it("rotating the token secret revokes sessions (secret changes)", () => {
    const owner = createOwner();
    const before = store.getTokenSecret(owner.id);
    expect(typeof before).toBe("string");
    expect(store.rotateTokenSecret(owner.id)).toBe(true);
    const after = store.getTokenSecret(owner.id);
    expect(after).not.toBe(before);
  });

  it("disabled members cannot log in and expose no token secret", () => {
    const owner = createOwner();
    const member = store.createMember({
      email: "m@example.com",
      password: "member password",
    });
    store.updateMember({ memberId: member.id, disabled: true });
    expect(
      store.verifyMemberPassword({
        email: "m@example.com",
        password: "member password",
      }),
    ).toBeNull();
    expect(store.getTokenSecret(member.id)).toBeNull();
    expect(store.getTokenSecret(owner.id)).toBeTruthy();
  });

  it("guards the last active admin against demotion, disable, and removal (D9)", () => {
    const owner = createOwner();
    expect(() =>
      store.updateMember({ memberId: owner.id, role: "member" }),
    ).toThrow(expect.objectContaining({ code: "last_admin" }));
    expect(() =>
      store.updateMember({ memberId: owner.id, disabled: true }),
    ).toThrow(expect.objectContaining({ code: "last_admin" }));
    expect(() => store.removeMember(owner.id)).toThrow(
      expect.objectContaining({ code: "last_admin" }),
    );

    // With a second admin the same operations succeed.
    store.createMember({
      email: "second@example.com",
      role: "admin",
      password: "second password",
    });
    expect(
      store.updateMember({ memberId: owner.id, role: "member" }).role,
    ).toBe("member");
  });

  it("consumes an invite exactly once under a race (CEO finding 4)", () => {
    const owner = createOwner();
    const invite = store.createInvite({
      role: "member",
      createdBy: owner.id,
    });
    expect(typeof invite.token).toBe("string");
    // Only the hash is stored — the raw token is not queryable.
    const rows = getAuthDb()
      .prepare("SELECT token_hash FROM member_invites")
      .all();
    expect(rows[0].token_hash).not.toContain(invite.token);

    const first = store.consumeInvite({ token: invite.token });
    const second = store.consumeInvite({ token: invite.token });
    expect(first).toEqual(expect.objectContaining({ id: invite.id }));
    expect(second).toBeNull();
  });

  it("expired and unknown invites do not consume", () => {
    const owner = createOwner();
    const invite = store.createInvite({ createdBy: owner.id, ttlMs: 60_000 });
    now += 61_000;
    expect(store.consumeInvite({ token: invite.token })).toBeNull();
    expect(store.consumeInvite({ token: "no-such-token" })).toBeNull();
    expect(store.purgeExpiredInvites()).toBe(1);
    expect(store.listInvites()).toEqual([]);
  });

  it("lists open invites and deletes them", () => {
    const owner = createOwner();
    const invite = store.createInvite({
      email: "Invitee@Example.com",
      createdBy: owner.id,
    });
    const listed = store.listInvites();
    expect(listed).toHaveLength(1);
    expect(listed[0].email).toBe("invitee@example.com");
    expect(listed[0].token).toBeUndefined();
    expect(store.deleteInvite(invite.id)).toBe(true);
    expect(store.listInvites()).toEqual([]);
  });
});
