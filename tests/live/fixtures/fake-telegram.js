// Fake Telegram Bot API for the live tier, ported from the GST-1975 E3 harness
// (e3/lib/fakes/telegram.mjs). It serves the methods OpenClaw's Telegram
// channel (grammY) calls, queues inbound updates a test injects, and records
// every call and every delivered message in memory. Nothing here reaches
// Telegram.
const http = require("http");

const kDelivery = /^(send[A-Z]\w*|forwardMessages?|copyMessages?|editMessage\w*|sendMediaGroup)$/;

const createFakeTelegram = ({ bot = { id: 7000000001, username: "wintermute_live_bot", first_name: "Wintermute" }, world }) => {
  const calls = [];
  const delivered = [];
  let nextUpdate = 1;
  let polls = 0;
  const queue = [];
  const waiters = new Set();
  const msgIds = new Map();
  const nextMsgId = (chat) => {
    const n = (msgIds.get(String(chat)) ?? 1000) + 1;
    msgIds.set(String(chat), n);
    return n;
  };
  const botUser = { id: bot.id, is_bot: true, first_name: bot.first_name, username: bot.username };
  const chatObj = (id) => {
    const c = world.chats[String(id)];
    if (c) return { id: Number(id), type: c.type, title: c.title, ...(c.is_forum ? { is_forum: true } : {}), ...(c.type === "private" ? { first_name: c.title } : {}) };
    return { id: Number(id), type: Number(id) < 0 ? "supergroup" : "private", title: "unknown " + id };
  };
  const userObj = (id) => {
    const u = world.users[String(id)];
    return { id: Number(id), is_bot: !!u?.bot, first_name: u?.first ?? "User", ...(u?.username ? { username: u.username } : {}) };
  };
  const wake = () => {
    for (const w of waiters) w();
    waiters.clear();
  };

  const inject = ({ from, chat, topic, text }) => {
    const message_id = nextMsgId(chat);
    const msg = { message_id, date: Math.floor(Date.now() / 1000), chat: chatObj(chat), from: userObj(from), text };
    if (topic) {
      msg.message_thread_id = Number(topic);
      msg.is_topic_message = true;
    }
    const update = { update_id: nextUpdate++, message: msg };
    queue.push(update);
    wake();
    return update;
  };

  // The bot being added to a group by someone: the my_chat_member update.
  const injectAdded = ({ chat, by }) => {
    const now = Math.floor(Date.now() / 1000);
    const update = {
      update_id: nextUpdate++,
      my_chat_member: {
        chat: chatObj(chat),
        from: userObj(by),
        date: now,
        old_chat_member: { status: "left", user: botUser },
        new_chat_member: { status: "member", user: botUser },
      },
    };
    queue.push(update);
    wake();
    return update;
  };

  const result = (method, p) => {
    switch (method) {
      case "getMe":
        return { ...botUser, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
      case "getChat":
        return { ...chatObj(p.chat_id), ...(world.chats[String(p.chat_id)]?.type === "private" ? {} : { permissions: {} }) };
      case "getChatMember":
        return { status: String(p.user_id) === String(bot.id) ? "administrator" : "member", user: String(p.user_id) === String(bot.id) ? botUser : userObj(p.user_id) };
      case "getChatAdministrators":
        return [{ status: "administrator", user: botUser }];
      case "getChatMemberCount":
        return 3;
      case "getMyCommands":
        return [];
      case "getWebhookInfo":
        return { url: "", has_custom_certificate: false, pending_update_count: 0 };
      case "getForumTopicIconStickers":
        return [];
      default:
        break;
    }
    if (kDelivery.test(method)) {
      const chat = p.chat_id ?? p.from_chat_id;
      const m = { message_id: method.startsWith("edit") ? Number(p.message_id) : nextMsgId(chat), date: Math.floor(Date.now() / 1000), chat: chatObj(chat), from: botUser };
      if (p.message_thread_id) m.message_thread_id = Number(p.message_thread_id);
      if (p.text !== undefined) m.text = String(p.text);
      delivered.push({ at: Date.now(), method, chat: String(chat ?? ""), text: String(p.text ?? p.caption ?? "") });
      return method === "sendMediaGroup" ? [m] : m;
    }
    return true;
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const ct = String(req.headers["content-type"] ?? "");
    if (!buf.length) return {};
    if (ct.includes("application/json")) {
      try {
        return JSON.parse(buf.toString("utf8"));
      } catch {
        return {};
      }
    }
    if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(buf.toString("utf8")));
    if (ct.includes("multipart/form-data")) {
      const out = {};
      const boundary = /boundary=("?)([^";]+)\1/.exec(ct)?.[2];
      if (!boundary) return out;
      for (const part of buf.toString("latin1").split("--" + boundary)) {
        const name = /name="([^"]+)"/.exec(part)?.[1];
        if (!name) continue;
        out[name] = Buffer.from(part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""), "latin1").toString("utf8");
      }
      return out;
    }
    return {};
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://x");
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!m) return send(404, { ok: false, error_code: 404, description: "Not Found" });
    const method = m[2];
    const p = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
    if (method === "getUpdates") {
      polls += 1;
      const offset = Number(p.offset ?? 0);
      if (offset) while (queue.length && queue[0].update_id < offset) queue.shift();
      const ready = () => queue.filter((u) => u.update_id >= offset);
      const timeout = Math.min(Number(p.timeout ?? 0), 10) * 1000;
      if (!ready().length && timeout > 0) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, timeout);
          waiters.add(() => {
            clearTimeout(t);
            resolve();
          });
          req.on("close", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      return send(200, { ok: true, result: ready().slice(0, Number(p.limit ?? 100)) });
    }
    calls.push({ at: Date.now(), method, chat: p.chat_id !== undefined ? String(p.chat_id) : null, text: p.text !== undefined ? String(p.text) : null, action: p.action ?? null });
    return send(200, { ok: true, result: result(method, p) });
  };

  const servers = [];
  return {
    inject,
    injectAdded,
    calls,
    delivered,
    polls: () => polls,
    pending: () => queue.length,
    async listen({ host = "127.0.0.1", port = 0 } = {}) {
      const server = http.createServer(handler);
      await new Promise((resolve) => server.listen(port, host, resolve));
      servers.push(server);
      return server.address().port;
    },
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.closeAllConnections?.();
              server.close(() => resolve());
            }),
        ),
      ),
  };
};

module.exports = { createFakeTelegram };
