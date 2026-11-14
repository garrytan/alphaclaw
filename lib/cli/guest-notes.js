// alphaclaw guest-notes sweep [--apply] [--json]
//
// The owner's host-side path for guest notes the broker can no longer reach.
// The broker reads and deletes a guest page only on behalf of that page's
// audience member; once the member has left the broker's may_act_for, the
// save is marked orphaned. This command lists those pages and, with
// --apply, deletes each one through the box's own gbrain CLI (a soft
// delete, restorable for 72 h), then marks it deleted so its kept file is
// removed after the restore window. Run it as root on the box.
const path = require("path");

const kGoneCodes = new Set(["page_not_found", "not_found"]);

const runGuestNotesCommand = async ({ argv = [], rootDir, json = false, write = (text) => process.stdout.write(text), runner = null, fsModule = require("fs") }) => {
  const [action, ...rest] = argv;
  if (action !== "sweep") {
    write("usage: alphaclaw guest-notes sweep [--apply] [--json]\n");
    return 2;
  }
  const apply = rest.includes("--apply");
  const { guestWritesPaths, kGuestSourceId } = require("../server/guest-writes/constants");
  const { openGuestStore } = require("../server/guest-writes/store");
  const paths = guestWritesPaths(rootDir);
  if (!fsModule.existsSync(paths.dbFile)) {
    write(json ? JSON.stringify({ ok: true, orphaned: [], deleted: [] }) + "\n" : "No guest notes on this box.\n");
    return 0;
  }
  const store = openGuestStore({ dbPath: paths.dbFile, fsModule });
  try {
    const orphaned = store.listOrphaned();
    const deleted = [];
    const pending = [];
    const kept = [];
    const failed = [];
    if (apply && orphaned.length) {
      let run = runner;
      if (!run) {
        const { createGbrainRunner, resolveGbrainBin } = require("../server/relay/brain-archive/gbrain");
        const configured = String(process.env.ALPHACLAW_RELAY_BRAIN_BIN || "").trim();
        const bin = resolveGbrainBin({ configured: configured.startsWith("/") ? configured : "" });
        if (!bin) {
          write(json ? JSON.stringify({ ok: false, code: "gbrain_missing" }) + "\n" : "The gbrain CLI was not found on this box.\n");
          return 1;
        }
        run = createGbrainRunner({ bin, cwd: path.dirname(paths.dir) }).run;
      }
      for (const row of orphaned) {
        const page = await run(["get", "--source", kGuestSourceId, "--json", "--", row.slug]);
        if (page.exitCode !== 0 && kGoneCodes.has(page.json?.code)) {
          store.updateSave(row.idemKey, { state: "deleted", deletedAt: Date.now() });
          deleted.push(row.slug);
          continue;
        }
        if (page.exitCode !== 0) {
          failed.push({ slug: row.slug, exitCode: page.exitCode, code: page.json?.code || "read_failed" });
          continue;
        }
        const promoted = [page?.json?.guest?.promoted, page?.json?.page?.guest?.promoted].some((value) => value === true || (typeof value === "string" && value.length > 0));
        if (promoted) {
          store.updateSave(row.idemKey, { state: "saved", promotedAt: Date.now(), errorCode: null });
          kept.push(row.slug);
          continue;
        }
        const result = await run(["delete", "--source", kGuestSourceId, "--json", "--", row.slug]);
        if (result.exitCode === 0) {
          store.updateSave(row.idemKey, { state: "deleted", deletedAt: Date.now() });
          deleted.push(row.slug);
        } else if (result.exitCode === 10) {
          pending.push(row.slug);
        } else {
          failed.push({ slug: row.slug, exitCode: result.exitCode, code: result.json?.code || null });
        }
      }
    }
    if (json) write(JSON.stringify({ ok: failed.length === 0, orphaned: orphaned.map((row) => row.slug), deleted, pending, kept, failed }) + "\n");
    else {
      write(orphaned.length ? orphaned.length + " orphaned guest note(s):\n" + orphaned.map((row) => "  " + row.slug).join("\n") + "\n" : "No orphaned guest notes.\n");
      if (apply) write("Deleted " + deleted.length + ", still pending " + pending.length + " (run again later), kept because promoted " + kept.length + ", failed " + failed.length + ".\n");
      else if (orphaned.length) write("Run again with --apply to delete them.\n");
    }
    return failed.length ? 1 : 0;
  } finally {
    store.close();
  }
};

module.exports = { runGuestNotesCommand };
