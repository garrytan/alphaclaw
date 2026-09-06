const parsePositiveInt = (value, fallbackValue) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
};

/** Read a clamped integer env knob: parse -> clamp into [min, max]. `unit` is
 * the suffix printed after the effective value in warnings ("s" for seconds
 * knobs, "" for bare counts) — the ONLY part of the warn text that varies
 * between knob families, so the seconds strings stay byte-identical to the
 * pre-refactor ones. Unset, empty, or whitespace-only means "use the default"
 * and is silent; anything the operator actually wrote that we did not honor
 * verbatim warns exactly once, so a value set mid-incident is never silently
 * swapped for one they didn't choose.
 * Precedence when several apply: junk > clamped > normalized. */
const readClampedEnvNumber = (name, { fallback, min, max, unit = "" }) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const parsed = parsePositiveInt(raw, fallback);
  const effective = Math.min(max, Math.max(min, parsed));
  const range = `(valid range ${min}-${max})`;
  // Junk = parsePositiveInt fell back (not a positive integer string). Tested
  // on the raw text, not `parsed === fallback`, so "30" with fallback 30 is
  // not misreported.
  const rawInt = Number.parseInt(String(raw), 10);
  if (!(Number.isFinite(rawInt) && rawInt > 0)) {
    console.warn(
      `[alphaclaw] ${name}=${raw} not a positive integer — falling back to ${effective}${unit} ${range}`,
    );
  } else if (effective !== parsed) {
    console.warn(`[alphaclaw] ${name}=${raw} clamped to ${effective}${unit} ${range}`);
  } else if (String(parsed) !== String(raw).trim()) {
    console.warn(`[alphaclaw] ${name}=${raw} normalized to ${effective}${unit} ${range}`);
  }
  return effective;
};

/** Seconds-valued knob. Returns SECONDS (callers multiply at the site so units
 * stay explicit); warnings carry the "s" suffix. */
const readClampedEnvSeconds = (name, options) =>
  readClampedEnvNumber(name, { ...options, unit: "s" });

/** Bare count knob (thresholds, attempt caps); warnings carry no unit. */
const readClampedEnvCount = (name, options) =>
  readClampedEnvNumber(name, { ...options, unit: "" });

module.exports = {
  parsePositiveInt,
  readClampedEnvNumber,
  readClampedEnvSeconds,
  readClampedEnvCount,
};
