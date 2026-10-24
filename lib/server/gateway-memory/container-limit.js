// What happens when the container reaches its memory limit (ALPH-25). The
// cgroup's own counters are the evidence (`cgroupPressure.events` on the
// memory sample): `oomKill` counts processes the kernel killed inside this
// container, `max` how often usage hit the limit. A container that hits its
// limit with no kill is not being rescued by the kernel; platforms such as
// Render then restart the whole instance, gateway included. Only an observed
// kernel kill lets the owner's notice say the kernel will kill a process.
const kPlatforms = [
  { id: "render", label: "Render", restartsAtLimit: true, match: (env) => !!(env.RENDER || env.RENDER_SERVICE_ID) },
  { id: "railway", label: "Railway", restartsAtLimit: false,
    match: (env) => Object.keys(env).some((key) => key.startsWith("RAILWAY_") && !!env[key]) },
  { id: "fly", label: "Fly.io", restartsAtLimit: false, match: (env) => !!(env.FLY_APP_NAME || env.FLY_MACHINE_ID) },
];

// kernel_kills: the kernel has killed a process in this container.
// instance_restart: no kill seen and a platform marker; `restartsAtLimit`
//   says whether that platform is known to restart the instance at its limit
//   (Render) or only likely to (Railway, Fly.io).
// unknown: no kill seen and no platform marker.
const resolveContainerLimitBehavior = ({ events = null, env = process.env } = {}) => {
  const platform = kPlatforms.find((entry) => entry.match(env)) ?? null;
  const base = {
    platform: platform?.id ?? null, platformLabel: platform?.label ?? null,
    source: events?.source ?? null, limitHits: events?.max ?? null, oomKills: events?.oomKill ?? null,
  };
  if (base.oomKills > 0) return { kind: "kernel_kills", ...base };
  if (platform) return { kind: "instance_restart", restartsAtLimit: platform.restartsAtLimit, ...base };
  return { kind: "unknown", ...base };
};

module.exports = { resolveContainerLimitBehavior };
