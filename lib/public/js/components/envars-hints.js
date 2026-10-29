import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

const kHintByKey = {
  ANTHROPIC_API_KEY: html`from${" "}
    <a
      href="https://console.anthropic.com"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >console.anthropic.com</a
    >`,
  ANTHROPIC_TOKEN: html`from
    <code class="text-xs bg-field px-1 rounded">claude setup-token</code>`,
  OPENAI_API_KEY: html`from${" "}
    <a
      href="https://platform.openai.com"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >platform.openai.com</a
    >`,
  GEMINI_API_KEY: html`from${" "}
    <a
      href="https://aistudio.google.com"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >aistudio.google.com</a
    >`,
  ELEVENLABS_API_KEY: html`from${" "}
    <a
      href="https://elevenlabs.io"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >elevenlabs.io</a
    >${" "} · ${" "}
    <code class="text-xs bg-field px-1 rounded">XI_API_KEY</code> also
    supported`,
  GITHUB_WORKSPACE_REPO: html`use
    <code class="text-xs bg-field px-1 rounded">owner/repo</code> or
    <code class="text-xs bg-field px-1 rounded"
      >https://github.com/owner/repo</code
    >`,
  TELEGRAM_BOT_TOKEN: html`from${" "}
    <a
      href="https://t.me/BotFather"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >@BotFather</a
    >
    ·
    <a
      href="https://docs.openclaw.ai/channels/telegram"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >full guide</a
    >`,
  DISCORD_BOT_TOKEN: html`from${" "}
    <a
      href="https://discord.com/developers/applications"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >developer portal</a
    >
    ·
    <a
      href="https://docs.openclaw.ai/channels/discord"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >full guide</a
    >`,
  MISTRAL_API_KEY: html`from${" "}
    <a
      href="https://console.mistral.ai"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >console.mistral.ai</a
    >`,
  VOYAGE_API_KEY: html`from${" "}
    <a
      href="https://dash.voyageai.com"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >dash.voyageai.com</a
    >`,
  GROQ_API_KEY: html`from${" "}
    <a
      href="https://console.groq.com"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >console.groq.com</a
    >`,
  PARTICLE_API_KEY: html`from${" "}
    <a
      href="https://platform.particle.ai"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >platform.particle.ai</a
    >`,
  DEEPGRAM_API_KEY: html`from${" "}
    <a
      href="https://console.deepgram.com"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >console.deepgram.com</a
    >`,
  BRAVE_API_KEY: html`from${" "}
    <a
      href="https://brave.com/search/api/"
      target="_blank"
      class="hover:underline"
      style="color: var(--accent-link)"
      >brave.com/search/api</a
    >${" "} — free tier available`,
};

export const getHintContent = (envVar) => kHintByKey[envVar.key] || envVar.hint || "";
