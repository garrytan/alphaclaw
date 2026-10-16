// A bounded, secret-redacted transcript of the most recent openclaw doctor
// --fix run (any caller: boot, repair, medic, retry), so the upgrade alert's
// "View Doctor output" shows what Doctor said — the run-stream keeps only a
// 64 KiB tail in memory and process.log carries only the 30 s heartbeat.
//
//   <managedDir>/doctor-last-run.log   (0600, rewritten atomically)
//
// Every line is redacted with the same boundary the outcome detail uses
// (utils/redact.js redactLine with the child's actual secret values) before
// it is kept; the raw output is never written. The newest ~256 KiB survive;
// older lines are dropped from the head with a count.
const fs = require("fs");
const path = require("path");
const { redactLine } = require("./utils/redact");
const { writeFileAtomic } = require("./utils/safe-file");

const kDoctorTranscriptFileName = "doctor-last-run.log";
const kDoctorTranscriptMaxBytes = 256 * 1024;
const kTranscriptLineMaxChars = 4096;

const createDoctorTranscript = ({
  managedDir,
  header,
  secrets = null,
  fsModule = fs,
  maxBytes = kDoctorTranscriptMaxBytes,
  logger = console,
}) => {
  const filePath = path.join(managedDir, kDoctorTranscriptFileName);
  const partials = new Map();
  const lines = [];
  let bytes = 0;
  let dropped = 0;
  let dirty = true;
  let warned = false;
  const keep = (rawLine) => {
    const line = redactLine(rawLine, { secrets, maxLength: kTranscriptLineMaxChars });
    if (!line) return;
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
    while (bytes > maxBytes && lines.length > 1) {
      bytes -= Buffer.byteLength(lines.shift()) + 1;
      dropped += 1;
    }
    dirty = true;
  };
  const onOutput = (chunkText, streamName = "stdout") => {
    const parts = (String(partials.get(streamName) || "") + String(chunkText ?? "")).split("\n");
    let partial = parts.pop();
    if (partial.length > kTranscriptLineMaxChars) partial = partial.slice(-kTranscriptLineMaxChars);
    partials.set(streamName, partial);
    for (const line of parts) keep(line);
  };
  const flush = ({ footer = null } = {}) => {
    if (footer != null) {
      for (const [streamName, partial] of partials) {
        if (partial) keep(partial);
        partials.set(streamName, "");
      }
    }
    if (!dirty && footer == null) return;
    dirty = false;
    const body = [
      header,
      ...(dropped > 0 ? ["[… " + dropped + " earlier line(s) dropped to keep this file bounded]"] : []),
      ...lines,
      ...(footer != null ? [footer] : ["[still running]"]),
    ].join("\n");
    try {
      writeFileAtomic(filePath, body + "\n", { fsModule, mode: 0o600 });
    } catch (error) {
      if (!warned) {
        warned = true;
        logger.warn?.("[alphaclaw] could not write the doctor --fix transcript: " + (error?.code || error?.message));
      }
    }
  };
  return { onOutput, flush, filePath };
};

const readDoctorTranscript = ({ managedDir, fsModule = fs, maxBytes = kDoctorTranscriptMaxBytes }) => {
  const filePath = path.join(managedDir, kDoctorTranscriptFileName);
  try {
    const stat = fsModule.statSync(filePath);
    if (!stat.isFile()) return null;
    const text = fsModule.readFileSync(filePath, "utf8");
    return { path: filePath, text: text.length > maxBytes * 2 ? text.slice(-maxBytes * 2) : text, bytes: stat.size, updatedAt: stat.mtimeMs };
  } catch {
    return null;
  }
};

module.exports = {
  kDoctorTranscriptFileName,
  kDoctorTranscriptMaxBytes,
  createDoctorTranscript,
  readDoctorTranscript,
};
