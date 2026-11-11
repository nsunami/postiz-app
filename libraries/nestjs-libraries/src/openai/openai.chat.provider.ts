import { createOpenAI } from '@ai-sdk/openai';
import {
  openaiApiKey,
  openaiBaseURL,
} from '@gitroom/nestjs-libraries/openai/openai.config';

// The Vercel AI SDK defaults to the Responses API when the provider is called
// directly (`openai(model)`). OpenAI-compatible routers such as OpenRouter do
// not implement /responses, so every AI SDK consumer asks for a Chat
// Completions model explicitly with `.chat(model)`.
export const openaiChatProvider = createOpenAI({
  apiKey: openaiApiKey(),
  baseURL: openaiBaseURL(),
});
