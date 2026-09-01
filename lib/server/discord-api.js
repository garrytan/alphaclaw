const kDiscordApiBase = "https://discord.com/api/v10";

const createDiscordApi = (getToken) => {
  const call = async (path, { method = "GET", body } = {}) => {
    const token = typeof getToken === "function" ? getToken() : getToken;
    if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
    const res = await fetch(`${kDiscordApiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.message || `Discord API error: ${method} ${path}`);
      err.discordStatusCode = res.status;
      throw err;
    }
    return data;
  };

  const createDmChannel = (userId) =>
    call("/users/@me/channels", {
      method: "POST",
      body: { recipient_id: String(userId || "") },
    });

  const sendMessage = (channelId, content, opts = {}) =>
    call(`/channels/${channelId}/messages`, {
      method: "POST",
      body: {
        content: String(content || ""),
        // Discord message flag 4 = SUPPRESS_EMBEDS: watchdog notifications
        // carry rescue capability links — Discord's crawler must not follow
        // (and thereby redeem) them to build an embed.
        ...(opts.suppressEmbeds ? { flags: 4 } : {}),
      },
    });

  const sendDirectMessage = async (userId, content, opts = {}) => {
    const channel = await createDmChannel(userId);
    return sendMessage(channel?.id, content, opts);
  };

  return {
    createDmChannel,
    sendMessage,
    sendDirectMessage,
  };
};

module.exports = { createDiscordApi };
