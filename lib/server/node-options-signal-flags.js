// Node diagnostic flags that hook a signal OpenClaw itself uses (ALPH-34).
//
// Node installs `--heapsnapshot-signal=<sig>` and `--report-on-signal`
// (signal from `--report-signal`, default SIGUSR2) as ordinary
// `process.on(<sig>)` listeners. OpenClaw 2026.10.7 uses two of those
// signals for restarts:
//   SIGUSR2  the gateway's restart signal: `gateway run` handles it
//            (run-*.mjs onRestartSignal), and the in-process scheduler
//            delivers every restart as `process.emit("SIGUSR2")`
//            (restart-*.mjs emitGatewayRestart), which runs every listener.
//   SIGUSR1  `openclaw gateway restart` signals the gateway pid with it when
//            the gateway lock names no owner (lifecycle-*.mjs).
// With the flag set, every restart request writes a heap snapshot of the
// whole gateway heap (hundreds of MB, the gateway frozen while it writes);
// a restart requested once a minute fills a disk in hours. The extra
// listener also makes `process.listenerCount("SIGUSR2") > 0` true in every
// OpenClaw CLI process, which changes how OpenClaw delivers a restart.
//
// gatewayEnv() drops these flags from the gateway's and the openclaw CLI's
// NODE_OPTIONS only. AlphaClaw's own process and the operator's settings are
// left alone; the Doctor card built from findSignalCollisions() explains it.
const kOpenclawSignals = new Set(["SIGUSR1", "SIGUSR2"]);
const kDefaultReportSignal = "SIGUSR2";

// Node accepts `_` for `-` inside option names.
const optionName = (token) => {
  const name = token.split("=", 1)[0];
  return name.startsWith("--") ? `--${name.slice(2).replace(/_/g, "-")}` : name;
};

const tokenize = (nodeOptions) => String(nodeOptions || "").split(/\s+/).filter(Boolean);

// Each entry: { name, start, end, value } where tokens[start..end) is the
// option and its value (`--flag=value` or `--flag value`).
const readValueOption = (tokens, index, name) => {
  const token = tokens[index];
  if (token.includes("=")) return { name, start: index, end: index + 1, value: token.slice(token.indexOf("=") + 1) };
  const next = tokens[index + 1];
  if (next !== undefined && !next.startsWith("-")) return { name, start: index, end: index + 2, value: next };
  return { name, start: index, end: index + 1, value: "" };
};

const scan = (tokens) => {
  const heapSnapshot = [];
  const reportOnSignal = [];
  let reportSignal = kDefaultReportSignal;
  for (let i = 0; i < tokens.length; i += 1) {
    const name = optionName(tokens[i]);
    if (name === "--heapsnapshot-signal") {
      const option = readValueOption(tokens, i, name);
      heapSnapshot.push(option);
      i = option.end - 1;
    } else if (name === "--report-signal") {
      const option = readValueOption(tokens, i, name);
      reportSignal = option.value;
      i = option.end - 1;
    } else if (name === "--report-on-signal") {
      reportOnSignal.push({ name, start: i, end: i + 1 });
    }
  }
  return {
    heapSnapshot: heapSnapshot.filter((option) => kOpenclawSignals.has(option.value)),
    reportOnSignal: kOpenclawSignals.has(reportSignal)
      ? reportOnSignal.map((option) => ({ ...option, value: reportSignal }))
      : [],
  };
};

// [{ flag, signal }] for every colliding flag, in NODE_OPTIONS order.
const findSignalCollisions = (nodeOptions) => {
  const { heapSnapshot, reportOnSignal } = scan(tokenize(nodeOptions));
  return [...heapSnapshot, ...reportOnSignal]
    .sort((a, b) => a.start - b.start)
    .map((option) => ({ flag: option.name, signal: option.value }));
};

// { nodeOptions, collisions }: NODE_OPTIONS without the colliding flags.
const stripSignalCollisionFlags = (nodeOptions) => {
  const tokens = tokenize(nodeOptions);
  const { heapSnapshot, reportOnSignal } = scan(tokens);
  const dropped = new Set();
  for (const option of [...heapSnapshot, ...reportOnSignal]) {
    for (let i = option.start; i < option.end; i += 1) dropped.add(i);
  }
  return {
    nodeOptions: tokens.filter((_, index) => !dropped.has(index)).join(" "),
    collisions: findSignalCollisions(nodeOptions),
  };
};

module.exports = { findSignalCollisions, kOpenclawSignals, stripSignalCollisionFlags };
