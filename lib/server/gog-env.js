// gog gets an allowlisted environment, never AlphaClaw's whole one (the setup
// password, platform tokens and provider keys): the basics a CLI needs, proxy
// and CA settings, gog's own GOG_* settings, and the managed config dir. gog
// v0.11.0 takes the file-keyring password only from GOG_KEYRING_PASSWORD (or a
// TTY prompt), so that one value still rides its environment.
const kGogEnvKeys = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM", "NO_COLOR",
  "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);

const gogEnv = ({ configHome, keyringPassword: GOG_KEYRING_PASSWORD, env = process.env }) => ({
  ...Object.fromEntries(
    Object.entries(env || {}).filter(
      ([key, value]) =>
        typeof value === "string" && (kGogEnvKeys.has(key) || key.startsWith("LC_") || key.startsWith("GOG_")),
    ),
  ),
  XDG_CONFIG_HOME: configHome,
  GOG_KEYRING_PASSWORD,
});

module.exports = { gogEnv };
