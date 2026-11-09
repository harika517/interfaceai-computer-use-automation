// OpenAI implementation of the LLM boundary, using chat completions with
// one tool per UI step kind. Retries are off so every API call is counted.

import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { LlmError, type LlmProvider, type LlmReply, type LlmRequest } from "./provider.js";

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high",
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async nextStep(request: LlmRequest): Promise<LlmReply> {
    const userContent: string | ChatCompletionContentPart[] = request.screenshotPng
      ? [
          { type: "text", text: request.user },
          { type: "image_url", image_url: { url: `data:image/png;base64,${request.screenshotPng.toString("base64")}` } },
        ]
      : request.user;

    let response;
    try {
      response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: userContent },
          ],
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: "required",
          parallel_tool_calls: false,
          max_completion_tokens: 4000,
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        },
        { timeout: request.timeoutMs },
      );
    } catch (error) {
      // Never include request details: only the provider's status and message.
      const status = error instanceof OpenAI.APIError ? ` (HTTP ${error.status})` : "";
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmError(`OpenAI request failed${status}: ${message}`);
    }

    const choice = response.choices[0];
    const message = choice?.message;
    const call = message?.tool_calls?.find((c) => c.type === "function");
    let args: unknown;
    if (call && call.type === "function") {
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = undefined;
      }
    }
    return {
      toolName: call && call.type === "function" ? call.function.name : undefined,
      args,
      finishReason: choice?.finish_reason ?? undefined,
      model: response.model,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
