const fs = require("fs");
const crypto = require("crypto");
const { writeFileAtomic } = require("../utils/safe-file");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const {
  kGuestSourceId,
  kGuestMarkerCapability,
  kClaimTtlMs,
  kRestoreWindowMs,
  kSweepIntervalMs,
  kCapabilityCacheMs,
  kMinMemberUid,
  kMaxTitleChars,
  kMaxSlugSuffix,
  kGuestNotesDefaults,
  kGroupSlugPattern,
  kMemberSlugPattern,
  kGroupKeyPattern,
  kMemberIdPattern,
  kGuestErrors,
  GuestWriteError,
  guestWritesPaths,
} = require("./constants");
const { groupSettings } = require("./config");
const { openGuestStore } = require("./store");
const render = require("./render");
const { pickupScratchFile, storeGuestFile, removeGuestFile } = require("./files");
const { createGbrainGuestClient, readBrokerCredential, classify } = require("./gbrain-client");

const kDayMs = 24 * 60 * 60 * 1000;
const kMaxBusyTries = 3;
const kFirstSweepDelayMs = 60 * 1000;
// gbrain marks a guest page the owner kept (guest.promoted) and refuses the
// broker's delete of it, so retention skips it.
const kPromotedRefusals = new Set(["guest_page_promoted"]);
const isPromoted = (page) => [page?.guest?.promoted, page?.page?.guest?.promoted].some((value) => value === true || (typeof value === "string" && value.length > 0));
const kSlugPattern = /^guests\/g[0-9a-f]{16}\/m[0-9a-f]{16}\/[a-z0-9-]{1,90}$/;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const isText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

// The claim the guard writes for a member's guest_save call. Every field is
// checked for shape only: the guard is the one place that knows who spoke,
// and it computes the group and member slugs with a key only it holds, so
// the broker takes them as given. The sender id is checked and never stored.
const parseClaim = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const ok =
    isText(b.run_id, 200) &&
    isText(b.session_key, 400) &&
    (b.parent_run_id === undefined || b.parent_run_id === null || isText(b.parent_run_id, 200)) &&
    typeof b.group_key === "string" &&
    kGroupKeyPattern.test(b.group_key) &&
    typeof b.audience_member === "string" &&
    kMemberIdPattern.test(b.audience_member) &&
    isText(b.sender_id, 200) &&
    isText(b.sender_label, 200) &&
    render.stripControls(b.sender_label).length > 0 &&
    typeof b.group_slug === "string" &&
    kGroupSlugPattern.test(b.group_slug) &&
    typeof b.member_slug === "string" &&
    kMemberSlugPattern.test(b.member_slug) &&
    Number.isInteger(b.member_uid) &&
    b.member_uid >= kMinMemberUid &&
    typeof b.channel === "string" &&
    /^[a-z][a-z0-9_-]{0,31}$/.test(b.channel);
  if (!ok) return null;
  return {
    runId: b.run_id,
    sessionKey: b.session_key,
    groupKey: b.group_key,
    groupSlug: b.group_slug,
    memberSlug: b.member_slug,
    memberUid: b.member_uid,
    audienceMember: b.audience_member,
    senderLabel: render.stripControls(b.sender_label).slice(0, 80),
    channel: b.channel,
  };
};

const parseSave = (body) => {
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.claim_ref !== "string") throw new GuestWriteError("claim_invalid");
  const title = render.stripControls(b.title);
  if (!title || title.length > kMaxTitleChars) throw new GuestWriteError("invalid_input");
  const hasText = b.text !== undefined && b.text !== null && b.text !== "";
  const hasFile = b.file_path !== undefined && b.file_path !== null && b.file_path !== "";
  if (b.kind === "note" && hasText && !hasFile && typeof b.text === "string") return { kind: "note", title, text: b.text, claimRef: b.claim_ref };
  if (b.kind === "file" && hasFile && !hasText && typeof b.file_path === "string") return { kind: "file", title, filePath: b.file_path, claimRef: b.claim_ref };
  throw new GuestWriteError("invalid_input");
};

// gbrain's write receipt (put_page, get_write_request) as one of our states.
const receiptState = (receipt) => {
  const state = [receipt?.state, receipt?.status, receipt?.outcome?.state].find((value) => typeof value === "string");
  if (!state) return typeof receipt?.slug === "string" ? "saved" : "pending";
  if (["committed", "applied", "published", "saved"].includes(state)) return "saved";
  if (["queued", "deferred", "running", "recovering", "pending", "write_pending"].includes(state)) return "pending";
  if (state === "conflict") return "revision";
  return "failed";
};

const sayFor = (status) =>
  status === "pending" ? "Saved; it will appear shortly. Don't save it again." : status === "duplicate" ? "Already saved as a guest note." : "Saved as a guest note.";

const createGuestWritesService = ({
  rootDir,
  readConfig,
  updateConfig = null,
  fsModule = fs,
  fetchImpl = globalThis.fetch,
  gbrainClient = null,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  version = "0",
}) => {
  const paths = guestWritesPaths(rootDir);
  const readCredential = () => readBrokerCredential(paths.clientFile, fsModule);
  const client = gbrainClient || createGbrainGuestClient({ readCredential, fetchImpl, now, version });
  let store = null;
  let capabilityCache = null;
  let sweepTimer = null;
  let firstSweepTimer = null;
  let sweeping = null;
  const inFlight = new Set();

  const getStore = () => {
    if (!store) store = openGuestStore({ dbPath: paths.dbFile, now, fsModule });
    return store;
  };
  const guestConfig = () => readConfig()?.guestNotes || { groups: {}, scratchRoot: null, retentionDays: kGuestNotesDefaults.retentionDays };

  const ensureSecret = () => {
    try {
      if (fsModule.readFileSync(paths.secretFile, "utf8").trim().length >= 32) return false;
    } catch {}
    fsModule.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(paths.secretFile, crypto.randomBytes(32).toString("hex"), { fsModule, mode: 0o600 });
    return true;
  };

  const isInternalSecret = (bearer) => {
    let secret = "";
    try {
      secret = fsModule.readFileSync(paths.secretFile, "utf8").trim();
    } catch {
      return false;
    }
    return secret.length >= 32 && typeof bearer === "string" && timingSafeStringEqual(bearer, secret);
  };

  const capability = async ({ fresh = false } = {}) => {
    if (!fresh && capabilityCache && capabilityCache.expiresAt > now()) return capabilityCache.value;
    let value;
    if (!readCredential()) value = { available: false, reason: "no_credential" };
    else {
      try {
        const identity = await client.brainIdentity();
        const capabilities = Array.isArray(identity?.capabilities) ? identity.capabilities : [];
        value = capabilities.includes(kGuestMarkerCapability) ? { available: true, reason: null } : { available: false, reason: "no_guest_marker" };
      } catch (error) {
        value = { available: false, reason: "gbrain_unreachable", code: error?.code || null };
      }
    }
    capabilityCache = { value, expiresAt: now() + (value.reason === "gbrain_unreachable" ? 60 * 1000 : kCapabilityCacheMs) };
    return value;
  };

  const claim = (body) => {
    const parsed = parseClaim(body);
    if (!parsed) return { ok: false, code: "invalid_claim" };
    const ref = crypto.randomBytes(32).toString("base64url");
    const db = getStore();
    db.pruneClaims();
    db.insertClaim(sha256(ref), { ...parsed, ttlMs: kClaimTtlMs });
    return { ok: true, claim_ref: ref, expires_at: new Date(now() + kClaimTtlMs).toISOString() };
  };

  const reconcile = async (row) => {
    try {
      const receipt = await client.callTool({ name: "get_write_request", args: { request_id: row.requestId }, onBehalfOf: row.audienceMember });
      return { state: receiptState(receipt), receipt };
    } catch (error) {
      const kind = classify(String(error?.code || ""));
      if (kind.denied) return { state: "denied" };
      if (kind.notFound) return { state: "absent" };
      return { state: "unknown" };
    }
  };

  // A failed save keeps no file: a refused write can't fill the disk.
  const markFailed = (row, errorCode) => {
    const db = getStore();
    const current = db.getSave(row.idemKey);
    if (current?.state === "saved") return current;
    if (current?.fileRel && removeGuestFile({ filesDir: paths.filesDir, rel: current.fileRel, fsModule })) {
      return db.updateSave(row.idemKey, { state: "failed", errorCode, fileRel: null });
    }
    return db.updateSave(row.idemKey, { state: "failed", errorCode });
  };

  const finalSlugOf = (receipt, slug) =>
    typeof receipt?.slug === "string" && kSlugPattern.test(receipt.slug) ? receipt.slug : slug;

  // Create-only writes: no expected_revision, no force. A slug that already
  // exists moves to the next -n slug with a new request id; a busy gbrain is
  // retried with the same request id; an answer we never got is read back
  // by request id before anything is sent again.
  const submit = async ({ row, page, claimRow }) => {
    const db = getStore();
    for (let n = row.attempt; n <= kMaxSlugSuffix; n += 1) {
      const slug = render.guestSlug({ groupSlug: row.groupSlug, memberSlug: row.memberSlug, day: row.day, title: row.title, n });
      const requestId = render.requestIdFor(row.idemKey, n);
      if (n !== row.attempt || slug !== row.slug || requestId !== row.requestId) {
        row = db.updateSave(row.idemKey, { attempt: n, slug, requestId, state: "submitting" });
      }
      const content = render.renderGuestPage({ ...page, groupSlug: row.groupSlug, memberSlug: row.memberSlug });
      let busyTries = 0;
      let nextSlug = false;
      while (!nextSlug) {
        let receipt;
        try {
          receipt = await client.callTool({
            name: "put_page",
            args: { slug, source_id: kGuestSourceId, content, content_origin: "tool_output", request_id: requestId },
            onBehalfOf: row.audienceMember,
            meta: { guest: { sender_label: render.guestLabel(page.senderLabel), group: row.groupSlug } },
          });
        } catch (error) {
          const code = String(error?.code || "gbrain_error");
          const kind = classify(code);
          if (error?.ambiguous) {
            const read = await reconcile(row);
            if (read.state === "saved" || read.state === "pending") {
              receipt = read.receipt;
            } else if (read.state === "absent" && busyTries < kMaxBusyTries) {
              busyTries += 1;
              continue;
            } else {
              db.updateSave(row.idemKey, { state: "submitting", errorCode: code });
              throw new GuestWriteError("guest_save_retry", code);
            }
          } else if (kind.revision) {
            nextSlug = true;
            continue;
          } else if (kind.retryable && busyTries < kMaxBusyTries) {
            await sleep(500 * 2 ** busyTries);
            busyTries += 1;
            continue;
          } else if (kind.retryable) {
            db.updateSave(row.idemKey, { state: "retry", errorCode: code });
            throw new GuestWriteError("guest_save_retry", code);
          } else {
            markFailed(row, code);
            log("[alphaclaw] guest-notes: gbrain refused a save code=" + code + " slug=" + slug);
            throw new GuestWriteError(code === "not_configured" ? "guest_saves_unavailable" : "guest_save_failed", code);
          }
        }
        const state = receiptState(receipt);
        if (state === "revision") {
          nextSlug = true;
          continue;
        }
        if (state === "failed") {
          const code = String(receipt?.write_error || "write_failed");
          markFailed(row, code);
          log("[alphaclaw] guest-notes: gbrain failed a save code=" + code + " slug=" + slug);
          throw new GuestWriteError("guest_save_failed", code);
        }
        const finalSlug = finalSlugOf(receipt, slug);
        db.updateSave(row.idemKey, { state, slug: finalSlug, errorCode: null });
        if (claimRow) db.spendClaim(claimRow);
        log("[alphaclaw] guest-notes: " + state + " slug=" + finalSlug);
        return { status: state, slug: finalSlug, requestId };
      }
    }
    markFailed(row, "slug_exhausted");
    throw new GuestWriteError("guest_save_failed", "slug_exhausted");
  };

  const save = async (body) => {
    const input = parseSave(body);
    const db = getStore();
    const refHash = sha256(input.claimRef);
    const claimRow = db.getClaim(refHash);
    if (!claimRow || claimRow.spentAt || claimRow.expiresAt < now()) throw new GuestWriteError("claim_invalid");
    const config = guestConfig();
    const settings = groupSettings(config, claimRow.groupKey);
    if (!settings.enabled) throw new GuestWriteError("guest_saves_off");
    const cap = await capability();
    if (!cap.available) throw new GuestWriteError("guest_saves_unavailable", cap.reason);
    const credential = readCredential();
    if (!credential) throw new GuestWriteError("guest_saves_unavailable", "no_credential");

    let bodyText;
    let digest;
    let picked = null;
    if (input.kind === "note") {
      if (input.text.length > kGuestNotesDefaults.maxNoteBytes * 4) throw new GuestWriteError("guest_note_too_large");
      bodyText = render.normalizeNoteText(input.text);
      if (!bodyText) throw new GuestWriteError("invalid_input");
      if (Buffer.byteLength(bodyText, "utf8") > kGuestNotesDefaults.maxNoteBytes) throw new GuestWriteError("guest_note_too_large");
      digest = render.sha256Hex(bodyText);
    } else {
      picked = pickupScratchFile({
        filePath: input.filePath,
        scratchRoot: config.scratchRoot,
        memberSlug: claimRow.memberSlug,
        memberUid: claimRow.memberUid,
        maxBytes: kGuestNotesDefaults.maxFileBytes,
        fsModule,
      });
      bodyText = render.fileNoteBody(picked);
      digest = picked.sha256;
    }
    const idemKey = render.idempotencyKey({ runId: claimRow.runId, kind: input.kind, contentDigest: digest });
    const page = {
      title: input.title,
      body: bodyText,
      ownerMember: credential.owner_member,
      audienceMember: claimRow.audienceMember,
      senderLabel: claimRow.senderLabel,
      savedAt: new Date(now()).toISOString(),
    };

    // One save per idempotency key at a time: a tool call retried while the
    // first is still in flight answers guest_save_retry instead of racing it.
    if (inFlight.has(idemKey)) throw new GuestWriteError("guest_save_retry", "in_flight");
    inFlight.add(idemKey);
    try {
      const existing = db.getSave(idemKey);
      if (existing && ["saved", "pending"].includes(existing.state)) {
        if (existing.state === "pending") {
          const read = await reconcile(existing);
          if (read.state === "saved") db.updateSave(idemKey, { state: "saved", slug: finalSlugOf(read.receipt, existing.slug) });
          if (read.state === "failed") {
            markFailed(existing, String(read.receipt?.write_error || "write_failed"));
            throw new GuestWriteError("guest_save_failed", "write_failed");
          }
          if (read.state === "denied" || read.state === "unknown") throw new GuestWriteError("guest_save_retry", read.state);
          if (read.state === "revision") {
            const result = await submit({ row: { ...existing, attempt: existing.attempt + 1 }, page: existing.page || page, claimRow: refHash });
            return { status: result.status, slug: result.slug, request_id: result.requestId, say: sayFor(result.status) };
          }
        }
        const current = db.getSave(idemKey);
        return { status: "duplicate", slug: current.slug, request_id: current.requestId, say: sayFor("duplicate") };
      }
      if (existing && ["submitting", "retry"].includes(existing.state)) {
        const read = await reconcile(existing);
        if (read.state === "saved" || read.state === "pending") {
          const slug = finalSlugOf(read.receipt, existing.slug);
          db.updateSave(idemKey, { state: read.state, slug, errorCode: null });
          db.spendClaim(refHash);
          return { status: read.state, slug, request_id: existing.requestId, say: sayFor(read.state) };
        }
        if (read.state !== "absent" && read.state !== "revision") throw new GuestWriteError("guest_save_retry", read.state);
        const result = await submit({ row: read.state === "revision" ? { ...existing, attempt: existing.attempt + 1 } : existing, page: existing.page || page, claimRow: refHash });
        return { status: result.status, slug: result.slug, request_id: result.requestId, say: sayFor(result.status) };
      }

      const day = render.dayOf(now());
      if (db.countDaily({ groupKey: claimRow.groupKey, memberSlug: claimRow.memberSlug, day }) >= settings.dailyCap) throw new GuestWriteError("guest_cap_reached", "daily");
      if (db.countLive({ groupKey: claimRow.groupKey, memberSlug: claimRow.memberSlug }) >= settings.liveCap) throw new GuestWriteError("guest_cap_reached", "live");

      const fileRel = picked
        ? storeGuestFile({ filesDir: paths.filesDir, groupSlug: claimRow.groupSlug, memberSlug: claimRow.memberSlug, saveId: idemKey.slice(0, 16), picked, fsModule })
        : null;
      const row = db.insertSave({
        idemKey,
        requestId: render.requestIdFor(idemKey, 1),
        attempt: 1,
        slug: render.guestSlug({ groupSlug: claimRow.groupSlug, memberSlug: claimRow.memberSlug, day, title: input.title, n: 1 }),
        state: "submitting",
        kind: input.kind,
        title: input.title,
        groupKey: claimRow.groupKey,
        groupSlug: claimRow.groupSlug,
        memberSlug: claimRow.memberSlug,
        audienceMember: claimRow.audienceMember,
        day,
        fileRel,
        page,
      });
      const result = await submit({ row, page, claimRow: refHash });
      return { status: result.status, slug: result.slug, request_id: result.requestId, say: sayFor(result.status) };
    } finally {
      inFlight.delete(idemKey);
    }
  };

  // Retention and settling, every few hours. Every gbrain call goes on
  // behalf of the page's own audience member. A member who has left the
  // broker's may_act_for can no longer be read or deleted through it: the
  // save is marked orphaned and only the owner's host-side sweep
  // (alphaclaw guest-notes sweep) removes it.
  const eachRow = async (list, visit) => {
    for (let after = ""; ; ) {
      const rows = list(after);
      if (!rows.length) return;
      for (const row of rows) await visit(row);
      after = rows[rows.length - 1].idemKey;
    }
  };

  const settleRow = async (row, out) => {
    const read = await reconcile(row);
    if (read.state === "saved" || read.state === "pending") {
      if (read.state !== row.state) {
        getStore().updateSave(row.idemKey, { state: read.state, slug: finalSlugOf(read.receipt, row.slug) });
        out.settled += 1;
      }
    } else if (read.state === "denied") {
      getStore().updateSave(row.idemKey, { state: "orphaned", errorCode: "not_in_may_act_for" });
      out.orphaned += 1;
    } else if (read.state === "revision") {
      if (!row.page) {
        markFailed(row, "slug_conflict");
      } else {
        try {
          await submit({ row: { ...row, attempt: row.attempt + 1 }, page: row.page, claimRow: null });
        } catch (error) {
          log("[alphaclaw] guest-notes: could not resend a save after a slug conflict code=" + String(error?.detail || error?.code || "unknown") + " slug=" + row.slug);
        }
      }
      out.settled += 1;
    } else if (read.state === "failed" || (read.state === "absent" && row.state !== "pending" && row.updatedAt < now() - kDayMs)) {
      log("[alphaclaw] guest-notes: gbrain never saved a guest note state=" + read.state + " slug=" + row.slug);
      markFailed(row, read.state === "absent" ? "not_accepted" : "write_failed");
      out.settled += 1;
    }
  };

  // gbrain refuses force and expected_revision on the guests source, so a
  // delete names only the slug and a request id of its own.
  const expireRow = async (row, out) => {
    const db = getStore();
    try {
      const page = await client.callTool({ name: "get_page", args: { slug: row.slug, source_id: kGuestSourceId }, onBehalfOf: row.audienceMember });
      if (isPromoted(page)) {
        db.updateSave(row.idemKey, { promotedAt: now() });
        out.promoted += 1;
        return;
      }
      const receipt = await client.callTool({
        name: "delete_page",
        args: { slug: row.slug, source_id: kGuestSourceId, request_id: render.requestIdFor(row.idemKey, "delete") },
        onBehalfOf: row.audienceMember,
      });
      const state = receiptState(receipt);
      if (state === "saved") {
        db.updateSave(row.idemKey, { state: "deleted", deletedAt: now() });
        out.deleted += 1;
      } else if (state !== "pending") {
        log("[alphaclaw] guest-notes: gbrain did not delete an expired note state=" + String(receipt?.state || "unknown") + " slug=" + row.slug);
      }
    } catch (error) {
      const code = String(error?.code || "");
      const kind = classify(code);
      if (kPromotedRefusals.has(code)) {
        db.updateSave(row.idemKey, { promotedAt: now() });
        out.promoted += 1;
      } else if (kind.notFound) {
        db.updateSave(row.idemKey, { state: "deleted", deletedAt: now() });
        out.deleted += 1;
      } else if (kind.denied) {
        db.updateSave(row.idemKey, { state: "orphaned", errorCode: "not_in_may_act_for" });
        out.orphaned += 1;
      } else {
        log("[alphaclaw] guest-notes: could not expire a note code=" + (code || "unknown") + " slug=" + row.slug);
      }
    }
  };

  // Retention and settling visit every row, a page at a time. A row a save
  // is working on is skipped, and the sweep holds each row it works on so a
  // save of the same note waits for it. Kept files past the restore window
  // are removed even when the broker has no gbrain credential.
  const runSweep = async () => {
    const db = getStore();
    const out = { settled: 0, deleted: 0, promoted: 0, orphaned: 0, filesRemoved: 0 };
    db.pruneClaims();
    const holding = (visit) => async (row) => {
      if (inFlight.has(row.idemKey)) return;
      inFlight.add(row.idemKey);
      try {
        await visit(row, out);
      } finally {
        inFlight.delete(row.idemKey);
      }
    };
    if (readCredential()) {
      await eachRow((after) => db.listUnsettled({ after }), holding(settleRow));
      const retentionDays = guestConfig().retentionDays || kGuestNotesDefaults.retentionDays;
      const olderThan = now() - retentionDays * kDayMs;
      await eachRow((after) => db.listExpired({ olderThan, after }), holding(expireRow));
    }
    const deletedBefore = now() - kRestoreWindowMs;
    await eachRow(
      (after) => db.listFilesPastRestore({ deletedBefore, after }),
      async (row) => {
        if (removeGuestFile({ filesDir: paths.filesDir, rel: row.fileRel, fsModule })) {
          db.updateSave(row.idemKey, { fileRel: null });
          out.filesRemoved += 1;
        }
      },
    );
    if (out.deleted || out.promoted || out.orphaned || out.settled || out.filesRemoved) {
      log("[alphaclaw] guest-notes: sweep settled=" + out.settled + " deleted=" + out.deleted + " promoted=" + out.promoted + " orphaned=" + out.orphaned + " filesRemoved=" + out.filesRemoved);
    }
    return out;
  };

  const sweep = () => {
    if (!sweeping) sweeping = runSweep().finally(() => (sweeping = null));
    return sweeping;
  };

  const status = async () => {
    const config = guestConfig();
    const counts = store || fsModule.existsSync(paths.dbFile) ? getStore().countsByGroup() : {};
    const groups = {};
    for (const key of new Set([...Object.keys(config.groups || {}), ...Object.keys(counts)])) {
      const c = counts[key] || {};
      groups[key] = {
        ...groupSettings(config, key),
        live: (c.saved || 0) + (c.pending || 0) + (c.submitting || 0) + (c.retry || 0),
        orphaned: c.orphaned || 0,
      };
    }
    const cap = await capability();
    return {
      available: cap.available,
      reason: cap.reason,
      credential: Boolean(readCredential()),
      fileSaves: Boolean(config.scratchRoot),
      retentionDays: config.retentionDays,
      defaults: { dailyCap: kGuestNotesDefaults.dailyCap, liveCap: kGuestNotesDefaults.liveCap },
      groups,
    };
  };

  // Turning a group on waits until the brain advertises the guest marker,
  // so no guest page is ever written without gbrain's warning. Turning one
  // off always works.
  const setGroup = async ({ groupKey, enabled }) => {
    if (typeof groupKey !== "string" || !kGroupKeyPattern.test(groupKey) || typeof enabled !== "boolean") throw new GuestWriteError("invalid_input");
    if (!updateConfig) throw new GuestWriteError("guest_save_failed", "no_writer");
    if (enabled && !(await capability({ fresh: true })).available) throw new GuestWriteError("guest_saves_unavailable");
    updateConfig((current) => {
      const guestNotes = current.guestNotes || { groups: {} };
      const groups = { ...(guestNotes.groups || {}) };
      groups[groupKey] = { ...(groups[groupKey] || {}), enabled };
      return { ...current, guestNotes: { ...guestNotes, groups } };
    });
    return groupSettings(guestConfig(), groupKey);
  };

  // A first sweep a minute after start, then every few hours, so a box
  // that restarts more often than the interval still runs retention.
  const runSweepLogged = () => sweep().catch((error) => log("[alphaclaw] guest-notes: sweep failed: " + (error?.code || error?.message || error)));
  const start = () => {
    ensureSecret();
    if (sweepTimer) return;
    firstSweepTimer = setTimeout(runSweepLogged, kFirstSweepDelayMs);
    firstSweepTimer.unref?.();
    sweepTimer = setInterval(runSweepLogged, kSweepIntervalMs);
    sweepTimer.unref?.();
  };

  const stop = () => {
    if (sweepTimer) clearInterval(sweepTimer);
    if (firstSweepTimer) clearTimeout(firstSweepTimer);
    sweepTimer = null;
    firstSweepTimer = null;
    store?.close();
    store = null;
  };

  return { paths, ensureSecret, isInternalSecret, capability, claim, save, sweep, status, setGroup, start, stop };
};

const describeGuestError = (error) => {
  const code = error instanceof GuestWriteError ? error.code : "guest_save_failed";
  return { code, ...kGuestErrors[code] };
};

module.exports = { createGuestWritesService, describeGuestError, parseClaim, parseSave, receiptState, GuestWriteError };
