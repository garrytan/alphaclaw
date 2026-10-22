// Doctor evidence snippets: bounded, containment-checked reads of the file
// windows a finding cites. Pure fs code, no service state.
const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const { resolveContainedPath } = require("../utils/safe-path");

const kMaxSnippetLines = 20;
// Generous: snippets are ≤ kMaxSnippetLines; the cap only bounds runaway lines.
const kSnippetRedactMaxChars = 10000;
// Chunk size for the forward scan that locates a cited line: findings can
// cite lines anywhere in a file, so the reader streams cap-sized chunks
// (keeping only the requested window) instead of buffering the whole file.
const kSnippetReadMaxBytes = 512 * 1024;
// Hard bound on the total bytes scanned to produce one snippet. Evidence
// snippets come from AI `openclaw doctor` output or the /api/doctor/import
// rawOutput, i.e. untrusted paths, and a huge in-workspace file must not
// exhaust memory or block the event loop (CX4): a citation whose window
// cannot be completed within this bound yields no snippet (null) rather than
// an unbounded read; when EOF is not reached within the bound, totalFileLines
// is dropped instead of scanning to EOF just to count lines.
const kSnippetScanMaxBytes = 8 * 1024 * 1024;

const readFileSnippet = (rootDir, relativePath, startLine, endLine, redact = (text) => text) => {
  try {
    // Containment: evidence paths come from LLM/bridge output — a traversal
    // or absolute path must never read outside the workspace into a card.
    const requestedPath = String(relativePath || "");
    if (path.isAbsolute(requestedPath)) return null;
    const root = path.resolve(rootDir);
    // Realpath-safe containment (H6, via the shared H4 primitive): a
    // `../../etc/passwd` or an in-workspace symlink must not escape the
    // workspace root — and the read below operates on the RETURNED canonical
    // path so it cannot re-follow the very symlink the check cleared.
    const contained = resolveContainedPath(
      path.resolve(root, requestedPath),
      root,
    );
    if (!contained.ok) return null;
    const realPath = contained.absolutePath;
    // Regular files only, checked BEFORE open: opening a FIFO for read blocks
    // until a writer appears. (No whole-file size cap: the bounded reader
    // below never scans past kSnippetScanMaxBytes regardless of file size, so
    // an oversized file costs a bounded read, not an OOM — CX4.)
    if (!fs.statSync(realPath).isFile()) return null;
    // Bounded windowed read through an fd: stream kSnippetReadMaxBytes-sized
    // chunks counting newlines until the requested [start, cappedEnd) window
    // is captured — a citation deep in a multi-MB file still gets its real
    // lines, but never more than kSnippetScanMaxBytes are read for one
    // snippet.
    const start = Math.max(0, (startLine || 1) - 1);
    const end = endLine && endLine >= startLine ? endLine : start + 1;
    const cappedEnd = Math.min(end, start + kMaxSnippetLines);
    const fd = fs.openSync(realPath, "r");
    const windowLines = [];
    // Known only when EOF is reached within the scan bound; dropped otherwise.
    let totalFileLines = null;
    try {
      const stats = fs.fstatSync(fd);
      if (!stats.isFile()) return null;
      const decoder = new StringDecoder("utf8");
      const chunk = Buffer.allocUnsafe(
        Math.min(Math.max(stats.size, 1), kSnippetReadMaxBytes),
      );
      let carry = "";
      let lineIndex = 0;
      let scannedBytes = 0;
      while (true) {
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, scannedBytes);
        if (bytesRead <= 0) {
          // EOF terminates the final line (an empty file is one empty line,
          // matching String.prototype.split("\n") on a full read).
          carry += decoder.end();
          if (lineIndex >= start && lineIndex < cappedEnd) windowLines.push(carry);
          totalFileLines = lineIndex + 1;
          break;
        }
        scannedBytes += bytesRead;
        const parts = (carry + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
        carry = parts.pop();
        for (const line of parts) {
          if (lineIndex >= start && lineIndex < cappedEnd) windowLines.push(line);
          lineIndex += 1;
        }
        if (lineIndex >= cappedEnd) {
          // Window complete. Keep scanning only to report totalFileLines, and
          // only when EOF is guaranteed inside the scan bound — otherwise stop
          // here and drop the field instead of reading up to the bound. (The
          // scannedBytes check keeps a file that grew after fstat bounded.)
          if (stats.size > kSnippetScanMaxBytes || scannedBytes >= kSnippetScanMaxBytes) {
            break;
          }
        } else if (scannedBytes >= kSnippetScanMaxBytes) {
          // Scan bound exhausted before the cited window was reached: no
          // snippet rather than an unbounded (or silently wrong) one.
          return null;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    // The cited startLine is past EOF: the line does not exist — no snippet.
    if (windowLines.length === 0) return null;
    return {
      text: redact(windowLines.join("\n")),
      startLine: start + 1,
      endLine: start + windowLines.length,
      // Truncated when the requested range was cut by kMaxSnippetLines (a
      // range clamped only by EOF is fully served, exactly like the full-read
      // implementation before the bounded reader).
      truncated:
        totalFileLines === null
          ? cappedEnd < end
          : Math.min(cappedEnd, totalFileLines) < Math.min(end, totalFileLines),
      ...(totalFileLines === null ? {} : { totalFileLines }),
    };
  } catch {
    return null;
  }
};

const captureEvidenceSnippets = (cards, rootDir, redact = (text) => text) => {
  for (const card of cards) {
    if (!Array.isArray(card.evidence)) continue;
    for (const item of card.evidence) {
      if (!item || typeof item !== "object") continue;
      // Only the server sets `snippet` (F114): drop anything that arrived with
      // the card, then read the cited window fresh.
      delete item.snippet;
      if (item.type !== "path" || !item.path || !item.startLine) continue;
      const snippet = readFileSnippet(rootDir, item.path, item.startLine, item.endLine, redact);
      if (snippet) item.snippet = snippet;
    }
  }
};

module.exports = {
  kSnippetRedactMaxChars,
  readFileSnippet,
  captureEvidenceSnippets,
};
