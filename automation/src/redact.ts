// Redaction (D-039). One set of rules for what the LLM sees and what is
// saved; saved text gets stricter rules on top.
//
// LLM view:  declared input values → <input:name>, credentials → [hidden],
//            values next to sensitive labels (e.g. Member Name) → [redacted],
//            and any value hidden once stays hidden everywhere afterwards
//            (step feedback, error text, reasons).
// Saved:     all of the above, plus amounts → $[amount] and long digit runs
//            (member IDs) masked to their last 2 digits.

import type { PageNode, PageView } from "./browser.js";

export const MAX_SAVED_SNAPSHOT_CHARS = 16_000;
// Painted over in a saved failure screenshot, as the log rules mask them.
export const SAVED_MASK_PATTERNS = [/\$\s?\d/, /\d{5,}/];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  private readonly inputPatterns: Array<{ name: string; pattern: RegExp }>;
  private readonly secrets: string[];
  private readonly hidden = new Set<string>(); // label values masked so far

  constructor(
    inputs: Record<string, string>,
    secrets: string[],
    private readonly sensitiveLabels: string[],
  ) {
    this.inputPatterns = Object.entries(inputs)
      .filter(([, value]) => value.length > 0)
      .map(([name, value]) => ({ name, pattern: new RegExp(`(?<![\\w])${escapeRegExp(value)}(?![\\w])`, "g") }));
    // Very short secrets would mangle ordinary text; demo credentials are longer.
    this.secrets = secrets.filter((secret) => secret.length >= 4);
  }

  forLlm(value: string): string {
    let out = value;
    for (const secret of this.secrets) out = out.split(secret).join("[hidden]");
    for (const value of this.hidden) out = out.split(value).join("[redacted]");
    for (const { name, pattern } of this.inputPatterns) out = out.replace(pattern, `<input:${name}>`);
    return out;
  }

  forLog(value: string): string {
    return this.forLlm(value)
      .replace(/\$\s?\d[\d,]*(\.\d+)?/g, "$[amount]")
      .replace(/(?<![\w•])\d{5,}(?![\w])/g, (digits) => `***${digits.slice(-2)}`);
  }

  // Page text for the LLM, with element references.
  pageForLlm(view: PageView): string {
    return this.forLlm(`Page: ${view.path}\n${render(this.maskLabels(view.nodes), 0, true)}`);
  }

  // Page text for saved evidence: stricter rules, no references, size-limited.
  pageForLog(view: PageView): string {
    const text = this.forLog(`Page: ${view.path}\n${render(this.maskLabels(view.nodes), 0, false)}`);
    return text.length > MAX_SAVED_SNAPSHOT_CHARS
      ? `${text.slice(0, MAX_SAVED_SNAPSHOT_CHARS)}\n[truncated at ${MAX_SAVED_SNAPSHOT_CHARS} characters]`
      : text;
  }

  isSensitiveLabel(label: string): boolean {
    return this.sensitiveLabels.some((l) => l.trim().toLowerCase() === label.trim().toLowerCase());
  }

  // Values shown right after a sensitive label ("Member Name" → "John Smith").
  private maskLabels(nodes: PageNode[]): PageNode[] {
    return nodes.map((node) => {
      const copy: PageNode = { ...node };
      if (node.children) {
        const children = this.maskLabels(node.children);
        for (let i = 0; i + 1 < children.length; i++) {
          const label = children[i]?.text ?? children[i]?.name;
          const next = children[i + 1];
          if (label && next?.text && this.isSensitiveLabel(label)) {
            // Very short values would mangle ordinary text when scrubbed elsewhere.
            if (next.text.trim().length >= 3) this.hidden.add(next.text.trim());
            children[i + 1] = { ...next, text: "[redacted]" };
          }
        }
        copy.children = children;
      }
      return copy;
    });
  }
}

// Compact text form of the page. Wrapper elements with nothing to show are
// collapsed so the LLM sees only meaningful lines.
function render(nodes: PageNode[], depth: number, withRefs: boolean): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const isWrapper = node.role === "generic" && !node.text && !node.name;
    if (isWrapper) {
      if (node.children) lines.push(render(node.children, depth, withRefs));
      continue;
    }
    let line = `${"  ".repeat(depth)}- ${node.role}`;
    if (node.name) line += ` "${node.name}"`;
    if (node.text) line += `: ${node.text}`;
    if (node.secret) line += " (value hidden)";
    if (node.secret && node.filled) line += " [filled]";
    if (node.level) line += ` [level=${node.level}]`;
    if (node.pressed) line += " [pressed]";
    if (node.disabled) line += " [disabled]";
    if (withRefs && node.ref) line += ` [ref=${node.ref}]`;
    lines.push(line);
    if (node.children) lines.push(render(node.children, depth + 1, withRefs));
  }
  return lines.filter((line) => line.length > 0).join("\n");
}

// Page text with no references and no redaction differences, used to tell
// whether the page changed between two steps.
export function pageKey(view: PageView): string {
  return `${view.path}\n${render(view.nodes, 0, false)}`;
}
