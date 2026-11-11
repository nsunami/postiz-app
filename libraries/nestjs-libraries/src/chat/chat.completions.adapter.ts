import { OpenAIAdapter } from '@copilotkit/runtime';
import { openaiChatProvider } from '@gitroom/nestjs-libraries/openai/openai.chat.provider';

// CopilotKit builds its default (built-in) agent from
// `serviceAdapter.getLanguageModel()`. The stock `OpenAIAdapter` resolves that
// to `createOpenAI(...)(model)`, which is the Responses API, so a chat-only
// OpenAI-compatible router rejects the request. The default agent has to talk
// over Chat Completions, like the Mastra agent does.
export class ChatCompletionsOpenAIAdapter extends OpenAIAdapter {
  getLanguageModel(): ReturnType<OpenAIAdapter['getLanguageModel']> {
    return openaiChatProvider.chat(this.model);
  }
}
