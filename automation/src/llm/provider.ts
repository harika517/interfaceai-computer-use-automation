// Swappable LLM boundary (D-037). Discovery hands over what the LLM should
// see and the UI steps it may choose, and gets back one chosen step. Each
// provider (OpenAI now; Claude or others later) implements only this.

import type { ToolSpec } from "../steps.js";

export interface LlmRequest {
  system: string;
  user: string;
  screenshotPng?: Buffer;
  tools: ToolSpec[];
  timeoutMs: number;
}

export interface LlmReply {
  toolName?: string; // missing when the LLM did not choose a step
  args?: unknown; // undefined when the arguments were not valid JSON
  finishReason?: string; // why the reply ended, e.g. "length" when it was cut off
  model: string; // model the provider reports it actually used
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  nextStep(request: LlmRequest): Promise<LlmReply>;
}

export class LlmError extends Error {}
