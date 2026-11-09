// Discovery settings (Module 2, D-039). Read once at startup from the
// environment; any invalid value stops the run before a browser opens.

export interface Limits {
  maxSteps: number;
  maxSeconds: number;
  maxFailures: number;
  maxLlmCalls: number;
}

export interface DiscoveryConfig {
  bankUrl: string; // approved origin, e.g. http://localhost:4000
  username: string;
  password: string;
  llm: {
    provider: "openai";
    model: string;
    apiKey: string;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
    priceInputPerMTok: number;
    priceOutputPerMTok: number;
  };
  limits: Limits;
  screenshotsForLlm: boolean;
  saveFailureScreenshot: boolean;
  headless: boolean;
  riskyKeywords: string[];
  sensitiveLabels: string[];
  runsDir: string;
  handoff: HandoffSettings;
}

// Human handoff limits (Module 5, D-051), shared by discovery and replay.
export interface HandoffSettings {
  timeoutSeconds: number; // how long a person may keep control
  maxHandoffs: number; // per run
}

export class ConfigError extends Error {}

const DEFAULT_RISKY_KEYWORDS = ["Edit Profile", "Transfer", "Delete", "Close Account", "Update"];
const DEFAULT_SENSITIVE_LABELS = ["Member Name"];

type Env = Record<string, string | undefined>;

// Shared readers: each records a problem instead of throwing, so every
// invalid setting is reported at once.
function settingsReader(env: Env) {
  const problems: string[] = [];

  const text = (name: string, fallback?: string): string => {
    const value = env[name]?.trim() || fallback;
    if (!value) {
      problems.push(`${name} is required.`);
      return "";
    }
    return value;
  };

  // Credentials are used exactly as given (no trimming). Very short ones
  // are refused because redaction could not safely scrub them from text.
  const secret = (name: string): string => {
    const value = env[name];
    if (!value || !value.trim()) {
      problems.push(`${name} is required.`);
      return "";
    }
    if (value.length < 4) problems.push(`${name} must be at least 4 characters so it can be redacted.`);
    return value;
  };

  const whole = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}").`);
      return fallback;
    }
    return value;
  };

  const price = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`${name} must be a non-negative number (got "${raw}").`);
      return fallback;
    }
    return value;
  };

  const onOff = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === "on" || raw === "true") return true;
    if (raw === "off" || raw === "false") return false;
    problems.push(`${name} must be on or off (got "${raw}").`);
    return fallback;
  };

  const list = (name: string, fallback: string[]): string[] => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
    // A value like "," would silently switch the protection off.
    if (items.length === 0) problems.push(`${name} must list at least one entry, or be left empty for the defaults.`);
    return items.length > 0 ? items : fallback;
  };

  const bankUrl = (): string => {
    const raw = text("BANK_URL", "http://localhost:4000");
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      return url.origin;
    } catch {
      problems.push(`BANK_URL must be an http(s) address (got "${raw}").`);
      return raw;
    }
  };

  const handoff = (): HandoffSettings => ({
    timeoutSeconds: whole("HANDOFF_TIMEOUT_SECONDS", 600, 10, 3600),
    maxHandoffs: whole("HANDOFF_MAX", 2, 1, 5),
  });

  return { problems, text, secret, whole, price, onOff, list, bankUrl, handoff };
}

export function readConfig(env: Env = process.env): DiscoveryConfig {
  const { problems, text, secret, whole, price, onOff, list, bankUrl: readBankUrl, handoff } = settingsReader(env);
  const bankUrl = readBankUrl();
  const provider = text("LLM_PROVIDER", "openai");
  if (provider !== "openai") problems.push(`LLM_PROVIDER must be "openai" (got "${provider}").`);

  const effortRaw = env.LLM_REASONING_EFFORT?.trim();
  const efforts = ["none", "minimal", "low", "medium", "high"] as const;
  type Effort = (typeof efforts)[number];
  if (effortRaw && !efforts.includes(effortRaw as Effort)) {
    problems.push(`LLM_REASONING_EFFORT must be one of ${efforts.join(", ")} (got "${effortRaw}").`);
  }

  const config: DiscoveryConfig = {
    bankUrl,
    username: secret("BANK_LOGIN_USERNAME"),
    password: secret("BANK_LOGIN_PASSWORD"),
    llm: {
      provider: "openai",
      model: text("LLM_MODEL", "gpt-5.4-mini-2026-03-17"),
      apiKey: text("OPEN_AI_KEY"),
      reasoningEffort: effortRaw && efforts.includes(effortRaw as Effort) ? (effortRaw as Effort) : undefined,
      priceInputPerMTok: price("LLM_PRICE_INPUT_PER_MTOK", 0.75),
      priceOutputPerMTok: price("LLM_PRICE_OUTPUT_PER_MTOK", 4.5),
    },
    limits: {
      maxSteps: whole("DISCOVERY_MAX_STEPS", 10, 1, 100),
      maxSeconds: whole("DISCOVERY_MAX_SECONDS", 120, 10, 1800),
      maxFailures: whole("DISCOVERY_MAX_FAILURES", 2, 1, 20),
      maxLlmCalls: whole("DISCOVERY_MAX_LLM_CALLS", 10, 1, 200),
    },
    screenshotsForLlm: onOff("DISCOVERY_SCREENSHOTS", false),
    saveFailureScreenshot: onOff("DISCOVERY_SAVE_FAILURE_SCREENSHOT", false),
    headless: onOff("BROWSER_HEADLESS", false),
    riskyKeywords: list("SAFETY_RISKY_KEYWORDS", DEFAULT_RISKY_KEYWORDS),
    sensitiveLabels: list("SAFETY_SENSITIVE_LABELS", DEFAULT_SENSITIVE_LABELS),
    runsDir: text("DISCOVERY_RUNS_DIR", "runs"),
    handoff: handoff(),
  };

  if (problems.length > 0) {
    throw new ConfigError(`Invalid discovery settings:\n- ${problems.join("\n- ")}`);
  }
  return config;
}

// Replay settings (Module 4, D-047 R6): the bank part only. Replay makes no
// LLM calls, so it needs no API key or model settings.
export interface ReplayConfig {
  bankUrl: string;
  username: string;
  password: string;
  maxSeconds: number;
  saveFailureScreenshot: boolean;
  headless: boolean;
  riskyKeywords: string[];
  sensitiveLabels: string[];
  runsDir: string;
  handoff: HandoffSettings;
}

export function readReplayConfig(env: Env = process.env): ReplayConfig {
  const { problems, text, secret, whole, onOff, list, bankUrl, handoff } = settingsReader(env);
  const config: ReplayConfig = {
    bankUrl: bankUrl(),
    username: secret("BANK_LOGIN_USERNAME"),
    password: secret("BANK_LOGIN_PASSWORD"),
    maxSeconds: whole("REPLAY_MAX_SECONDS", 60, 5, 600),
    saveFailureScreenshot: onOff("REPLAY_SAVE_FAILURE_SCREENSHOT", false),
    headless: onOff("BROWSER_HEADLESS", false),
    riskyKeywords: list("SAFETY_RISKY_KEYWORDS", DEFAULT_RISKY_KEYWORDS),
    sensitiveLabels: list("SAFETY_SENSITIVE_LABELS", DEFAULT_SENSITIVE_LABELS),
    runsDir: text("REPLAY_RUNS_DIR", "runs"),
    handoff: handoff(),
  };
  if (problems.length > 0) {
    throw new ConfigError(`Invalid replay settings:\n- ${problems.join("\n- ")}`);
  }
  return config;
}

// What gets recorded in run metadata: every setting except secrets.
export function describeConfig(config: DiscoveryConfig) {
  return {
    bankUrl: config.bankUrl,
    llm: {
      provider: config.llm.provider,
      model: config.llm.model,
      reasoningEffort: config.llm.reasoningEffort ?? "model default",
      priceInputPerMTok: config.llm.priceInputPerMTok,
      priceOutputPerMTok: config.llm.priceOutputPerMTok,
    },
    limits: config.limits,
    screenshotsForLlm: config.screenshotsForLlm,
    saveFailureScreenshot: config.saveFailureScreenshot,
    headless: config.headless,
    riskyKeywords: config.riskyKeywords,
    sensitiveLabels: config.sensitiveLabels,
    handoff: config.handoff,
  };
}
