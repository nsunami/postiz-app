// Postiz talks to OpenAI through four different clients (the official SDK,
// LangChain, the Vercel AI SDK and CopilotKit). They all accept an API key and
// a base URL, so a single set of env vars keeps them pointed at the same
// OpenAI-compatible backend (OpenAI, OpenRouter, an EU-hosted router, ...).
const trimmed = (value?: string) => value?.trim() || undefined;

export const openaiApiKey = () =>
  trimmed(process.env.OPENAI_API_KEY) || 'sk-proj-';

// Empty means the official OpenAI endpoint. OpenAI-compatible routers expose
// the same /v1 surface under their own host.
export const openaiBaseURL = () => trimmed(process.env.OPENAI_BASE_URL);

// Routers use their own model ids (OpenRouter expects e.g. "openai/gpt-4.1"),
// so the model is configurable instead of hardcoded.
export const openaiModel = () =>
  trimmed(process.env.OPENAI_MODEL) || 'gpt-4.1';

// The Mastra/Copilot agent talks over the Chat Completions API because routers
// such as OpenRouter do not implement the OpenAI Responses API.
export const openaiChatModel = () =>
  trimmed(process.env.OPENAI_CHAT_MODEL) || 'gpt-5.2';

export const openaiImageModel = () =>
  trimmed(process.env.OPENAI_IMAGE_MODEL) || 'chatgpt-image-latest';

// Image generation uses the OpenAI Images API, which chat-only routers do not
// expose. Setting a dedicated image endpoint (usually plain OpenAI) keeps image
// features working while text generation goes through a router.
export const openaiImageApiKey = () =>
  trimmed(process.env.OPENAI_IMAGE_API_KEY) || openaiApiKey();

export const openaiImageBaseURL = () =>
  trimmed(process.env.OPENAI_IMAGE_BASE_URL) || openaiBaseURL();
