const kTelegramApiBase = "https://api.telegram.org";

const createTelegramApi = (getToken) => {
  const call = async (method, params = {}) => {
    const token = typeof getToken === "function" ? getToken() : getToken;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const url = `${kTelegramApiBase}/bot${token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) {
      const err = new Error(data.description || `Telegram API error: ${method}`);
      err.telegramErrorCode = data.error_code;
      throw err;
    }
    return data.result;
  };

  const getMe = () => call("getMe");

  const getChat = (chatId) => call("getChat", { chat_id: chatId });

  const getChatMember = (chatId, userId) =>
    call("getChatMember", { chat_id: chatId, user_id: userId });

  const getChatAdministrators = (chatId) =>
    call("getChatAdministrators", { chat_id: chatId });

  const createForumTopic = (chatId, name, opts = {}) =>
    call("createForumTopic", {
      chat_id: chatId,
      name,
      ...(opts.iconColor != null && { icon_color: opts.iconColor }),
      ...(opts.iconCustomEmojiId && { icon_custom_emoji_id: opts.iconCustomEmojiId }),
    });

  const deleteForumTopic = (chatId, messageThreadId) =>
    call("deleteForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
    });

  const editForumTopic = (chatId, messageThreadId, opts = {}) =>
    call("editForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      ...(opts.name && { name: opts.name }),
      ...(opts.iconCustomEmojiId && { icon_custom_emoji_id: opts.iconCustomEmojiId }),
    });

  const sendChatAction = (chatId, action, opts = {}) =>
    call("sendChatAction", {
      chat_id: chatId,
      action,
      ...(opts.messageThreadId != null && {
        message_thread_id: opts.messageThreadId,
      }),
    });

  const sendMessage = (chatId, text, opts = {}) =>
    call("sendMessage", {
      chat_id: chatId,
      text: String(text || ""),
      ...(opts.parseMode && { parse_mode: opts.parseMode }),
      ...(opts.disableWebPagePreview && {
        disable_web_page_preview: !!opts.disableWebPagePreview,
      }),
    });

  return {
    getMe,
    getChat,
    getChatMember,
    getChatAdministrators,
    createForumTopic,
    deleteForumTopic,
    editForumTopic,
    sendChatAction,
    sendMessage,
  };
};

module.exports = { createTelegramApi };
