// Safety rules (D-017, D-039). Default-deny: a step runs only if it is a
// permitted kind, on an approved page, against a permitted element. Risky
// steps are blocked unless approved; Module 2 has no approval path yet, so a
// risky step stops the run with NEEDS_HUMAN and is never executed.

import type { ElementInfo } from "./browser.js";
import type { Step, StepKind } from "./steps.js";

export type SafetyVerdict =
  | { verdict: "allow" }
  | { verdict: "refuse"; reason: string } // the step is not run; the LLM is told why
  | { verdict: "needs_human"; reason: string }; // the run stops; a person must decide

type ElementRule = { name: string; treat: "risky" | "session_changing" };

export interface SafetyRules {
  origin: string;
  allowedPaths: string[];
  allowedKinds: StepKind[];
  elementRules: ElementRule[]; // explicit rules, checked first
  riskyKeywords: string[]; // fallback when no explicit rule matches
  sensitiveLabels: string[]; // values after these labels may not be read
  allowLogout: boolean;
  declaredInputs: string[];
  declaredOutputs: string[];
}

export function bankSafetyRules(options: {
  origin: string;
  riskyKeywords: string[];
  sensitiveLabels: string[];
  allowLogout: boolean;
  declaredInputs: string[];
  declaredOutputs: string[];
}): SafetyRules {
  return {
    origin: options.origin,
    allowedPaths: ["/", "/login", "/members"],
    allowedKinds: ["click", "fill", "read", "wait_for", "navigate", "request_human", "finish"],
    elementRules: [
      { name: "Edit Profile", treat: "risky" },
      { name: "Log Out", treat: "session_changing" },
    ],
    riskyKeywords: options.riskyKeywords,
    sensitiveLabels: options.sensitiveLabels,
    allowLogout: options.allowLogout,
    declaredInputs: options.declaredInputs,
    declaredOutputs: options.declaredOutputs,
  };
}

export interface StepContext {
  currentUrl: string;
  target?: ElementInfo; // element the step's reference points to
  targetIsSecret: boolean; // the target is a password box
}

const FILLABLE_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];
// Elements a person can act on. Their label is not a value on the page, so an
// output may not be read from one, and a business-outcome message must not be one.
export const CONTROL_ROLES = ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "tab", "option", "switch", "spinbutton"];
const STEPS_NEEDING_TARGET: StepKind[] = ["click", "fill", "read"];

export function isApprovedPage(rules: SafetyRules, url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === rules.origin && rules.allowedPaths.includes(parsed.pathname);
  } catch {
    return false;
  }
}

export function checkStep(rules: SafetyRules, step: Step, context: StepContext): SafetyVerdict {
  if (!rules.allowedKinds.includes(step.kind)) {
    return { verdict: "refuse", reason: `Step kind "${step.kind}" is not permitted.` };
  }
  // Asking for help or finishing is always allowed, even on an unexpected page.
  if (step.kind === "request_human" || step.kind === "finish") return { verdict: "allow" };

  if (!isApprovedPage(rules, context.currentUrl)) {
    return { verdict: "needs_human", reason: "The browser is on a page outside the approved area." };
  }

  if (STEPS_NEEDING_TARGET.includes(step.kind) && !context.target) {
    return { verdict: "refuse", reason: "That element reference is not on the current page." };
  }

  switch (step.kind) {
    case "navigate": {
      let target: URL;
      try {
        target = new URL(step.path, rules.origin);
      } catch {
        return { verdict: "refuse", reason: "Not a valid path." };
      }
      if (target.origin !== rules.origin || !rules.allowedPaths.includes(target.pathname) || target.search || target.hash) {
        return { verdict: "refuse", reason: `Navigation is limited to ${rules.allowedPaths.join(", ")} with no query.` };
      }
      return { verdict: "allow" };
    }
    case "click":
      return checkClick(rules, context.target!);
    case "fill":
      return checkFill(rules, step, context);
    case "read":
      return checkRead(rules, step.output, context);
    case "wait_for":
      return { verdict: "allow" };
  }
}

function checkClick(rules: SafetyRules, target: ElementInfo): SafetyVerdict {
  // Identify the element by name, else its visible text, else its label.
  const shown = (target.name || target.text || target.label || "").trim();
  if (!shown) {
    return { verdict: "refuse", reason: "That element has no name or text, so it cannot be checked for safety." };
  }
  const identity = shown.toLowerCase();
  const rule = rules.elementRules.find((r) => r.name.toLowerCase() === identity);
  if (rule?.treat === "risky") {
    return { verdict: "needs_human", reason: `"${shown}" is a risky action and needs a person's approval.` };
  }
  if (rule?.treat === "session_changing") {
    return rules.allowLogout
      ? { verdict: "allow" }
      : { verdict: "refuse", reason: `"${shown}" ends the session and this task does not permit it.` };
  }
  const keyword = rules.riskyKeywords.find((k) => identity.includes(k.toLowerCase()));
  if (keyword) {
    return { verdict: "needs_human", reason: `"${shown}" matches risky keyword "${keyword}" and needs a person's approval.` };
  }
  return { verdict: "allow" };
}

function checkRead(rules: SafetyRules, output: string, context: StepContext): SafetyVerdict {
  if (!rules.declaredOutputs.includes(output)) {
    return { verdict: "refuse", reason: `"${output}" is not a declared output.` };
  }
  if (context.target && CONTROL_ROLES.includes(context.target.role)) {
    return { verdict: "refuse", reason: `That is a ${context.target.role}; its label is not a value. Read the page text that shows the value.` };
  }
  const label = context.target?.label?.trim().toLowerCase();
  if (context.targetIsSecret || (label && rules.sensitiveLabels.some((l) => l.trim().toLowerCase() === label))) {
    return { verdict: "refuse", reason: "That element holds protected data and may not be read." };
  }
  return { verdict: "allow" };
}

function checkFill(rules: SafetyRules, step: Extract<Step, { kind: "fill" }>, context: StepContext): SafetyVerdict {
  const target = context.target!;
  if (!FILLABLE_ROLES.includes(target.role)) {
    return { verdict: "refuse", reason: `Cannot type into a ${target.role}.` };
  }
  const value = step.value;
  if ("credential" in value) {
    if (new URL(context.currentUrl).pathname !== "/login") {
      return { verdict: "refuse", reason: "Credentials may only be entered on the login page." };
    }
    const wantsSecretBox = value.credential === "password";
    if (wantsSecretBox !== context.targetIsSecret) {
      return { verdict: "refuse", reason: "The password goes only in the password box, and nothing else does." };
    }
    return { verdict: "allow" };
  }
  if (context.targetIsSecret) {
    return { verdict: "refuse", reason: "Only the password credential may be typed into a password box." };
  }
  if ("input" in value && !rules.declaredInputs.includes(value.input)) {
    return { verdict: "refuse", reason: `"${value.input}" is not a declared input.` };
  }
  return { verdict: "allow" };
}
