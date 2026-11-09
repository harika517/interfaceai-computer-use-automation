// Workflow lookup (D-047 R1): a request is matched against a short, fixed
// list of phrases per workflow (capabilities/phrases.json). Exact match only,
// apart from letter case, spacing and a final ".", "?" or "!". No LLM, no
// fuzzy or semantic matching: an unknown or ambiguous request is refused.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WORKFLOW_NAME } from "../workflow/schema.js";
import { ReplayRefused } from "./replay.js";

const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,39})\}/g;

export const Phrases = z.record(
  z.string().regex(WORKFLOW_NAME),
  z.array(z.string().trim().min(3).max(200)).min(1),
);

export function readPhrases(capabilitiesDir: string): z.infer<typeof Phrases> {
  const file = path.join(capabilitiesDir, "phrases.json");
  if (!existsSync(file)) throw new ReplayRefused("No capabilities/phrases.json: look up by request is not set up.");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ReplayRefused("capabilities/phrases.json is not valid JSON.");
  }
  const parsed = Phrases.safeParse(raw);
  if (!parsed.success) throw new ReplayRefused("capabilities/phrases.json is malformed.");
  return parsed.data;
}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").replace(/[.?!]$/, "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The input values come from the request exactly as typed; only the fixed
// words are compared without regard to case.
function matchPhrase(phrase: string, request: string): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = normalize(phrase)
    .split(PLACEHOLDER)
    .map((part, i) => (i % 2 === 1 ? (names.push(part), "(\\S+)") : escape(part)))
    .join("");
  const m = new RegExp(`^${pattern}$`, "i").exec(normalize(request));
  if (!m) return undefined;
  return Object.fromEntries(names.map((name, i) => [name, m[i + 1]!]));
}

export function lookup(request: string, phrases: z.infer<typeof Phrases>): { name: string; inputs: Record<string, string> } {
  const found: Array<{ name: string; inputs: Record<string, string> }> = [];
  for (const [name, list] of Object.entries(phrases)) {
    for (const phrase of list) {
      const inputs = matchPhrase(phrase, request);
      if (inputs) {
        found.push({ name, inputs });
        break; // one match per workflow is enough
      }
    }
  }
  if (found.length > 1) {
    throw new ReplayRefused(`The request matches more than one workflow (${found.map((f) => f.name).join(", ")}); not guessing.`);
  }
  if (found.length === 0) {
    const supported = Object.values(phrases).flat().map((p) => `  - ${p}`).join("\n");
    throw new ReplayRefused(`No recorded workflow matches this request. Supported requests:\n${supported}`);
  }
  return found[0]!;
}
