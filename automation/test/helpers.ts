// Test helpers: a real mock bank on a spare port, and a scripted fake LLM
// behind the same boundary as OpenAI (no API calls, no credits).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig, type DiscoveryConfig } from "../src/config.js";
import type { LlmProvider, LlmReply, LlmRequest } from "../src/llm/provider.js";

export const TEST_USERNAME = "teller-test";
export const TEST_PASSWORD = "test-password-9137";

export async function startBank(port: number, faults: Record<string, string> = {}): Promise<() => void> {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "mock-bank/src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      MOCK_BANK_USERNAME: TEST_USERNAME,
      MOCK_BANK_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: "test-session-secret",
      BANK_SESSION_TTL_SECONDS: "0",
      BANK_SLOW_MS: "0",
      BANK_SERVER_ERROR: "off",
      BANK_NOTICE: "off",
      ...faults,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/login`);
      if (res.ok) return () => child.kill();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`Mock bank did not start on port ${port}.`);
}

export function testConfig(port: number, overrides: Record<string, string> = {}): DiscoveryConfig {
  return readConfig({
    BANK_URL: `http://localhost:${port}`,
    BANK_LOGIN_USERNAME: TEST_USERNAME,
    BANK_LOGIN_PASSWORD: TEST_PASSWORD,
    OPEN_AI_KEY: "sk-test-not-a-real-key",
    BROWSER_HEADLESS: "on",
    DISCOVERY_RUNS_DIR: mkdtempSync(path.join(tmpdir(), "discovery-test-")),
    ...overrides,
  });
}

// Find the reference of the first page line matching a pattern.
export function refOf(page: string, pattern: RegExp | string): string {
  const line = page.split("\n").find((l) => (typeof pattern === "string" ? l.includes(pattern) : pattern.test(l)));
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (!ref) throw new Error(`No element matching ${pattern} on page:\n${page}`);
  return ref;
}

export type ScriptStep = (page: string) => { tool?: string; args?: unknown; delayMs?: number } | Error;

// Fake LLM: plays a fixed list of steps, one per call, and records every
// request so tests can check what the LLM would have been shown.
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model = "scripted-test-model";
  readonly requests: LlmRequest[] = [];
  private index = 0;

  constructor(private readonly script: ScriptStep[]) {}

  async nextStep(request: LlmRequest): Promise<LlmReply> {
    this.requests.push(request);
    const page = request.user.slice(request.user.indexOf("Current page:"));
    const next = this.script[this.index++];
    if (!next) throw new Error("Script ran out of steps.");
    const choice = next(page);
    if (choice instanceof Error) throw choice;
    if (choice.delayMs) await new Promise((r) => setTimeout(r, choice.delayMs));
    return { toolName: choice.tool, args: choice.args, model: this.model, usage: { inputTokens: 1000, outputTokens: 50 } };
  }
}

const why = { reason: "test step" };

export const loginSteps: ScriptStep[] = [
  (p) => ({ tool: "fill", args: { ref: refOf(p, 'textbox "Username"'), value: { credential: "username" }, ...why } }),
  (p) => ({ tool: "fill", args: { ref: refOf(p, 'textbox "Password"'), value: { credential: "password" }, ...why } }),
  (p) => ({ tool: "click", args: { ref: refOf(p, 'button "Sign In"'), ...why } }),
];

export const searchSteps: ScriptStep[] = [
  (p) => ({ tool: "fill", args: { ref: refOf(p, 'textbox "Member ID"'), value: { input: "member_id" }, ...why } }),
  (p) => ({ tool: "click", args: { ref: refOf(p, 'button "Search"'), ...why } }),
];

export const click = (name: string): ScriptStep => (p) => ({ tool: "click", args: { ref: refOf(p, `button "${name}"`), ...why } });

// Nothing the LLM must never see reached it, and nothing that must never be
// saved is in the run folder. Balances are checked separately: the LLM may
// see them, and result.json holds them when they are a declared output.
export function assertNoLeaks(runDir: string, llm: ScriptedProvider, extra: string[] = []): void {
  const forbidden = [TEST_USERNAME, TEST_PASSWORD, "John Smith", "sk-test-not-a-real-key", ...extra];
  const shown = llm.requests.map((r) => r.system + r.user).join("\n");
  const saved = ["run.jsonl", "result.json", "failure-snapshot.txt"]
    .map((f) => path.join(runDir, f))
    .filter(existsSync)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  for (const value of forbidden) {
    if (shown.includes(value)) throw new Error(`The LLM was shown "${value}".`);
    if (saved.includes(value)) throw new Error(`The run folder contains "${value}".`);
  }
}
