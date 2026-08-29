// Minimal out-of-band notification webhook (ALPHACLAW_NOTIFY_WEBHOOK_URL).
//
// This is the delivery path of last resort: it must keep working when every
// chat channel (Telegram/Discord/Slack/WhatsApp) is broken AND when the
// caller is the pre-server boot process — where there is no outbox, no
// notifier, and possibly no boot that ever completes. Best-effort by
// contract: swallows every error (bad URL, network, timeout, non-2xx) and
// reports a plain boolean. Never throws, never blocks beyond timeoutMs.
const kDefaultTimeoutMs = 5000;

const postNotifyWebhookDirect = async (
  message,
  { fetchImpl = fetch, env = process.env, timeoutMs = kDefaultTimeoutMs } = {},
) => {
  const url = String(env?.ALPHACLAW_NOTIFY_WEBHOOK_URL || "").trim();
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: String(message || "") }),
        signal: controller.signal,
      });
      return !!res?.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
};

module.exports = { postNotifyWebhookDirect };
