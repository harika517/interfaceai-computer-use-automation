// Finding elements and checking conditions for replay (D-047). Pure
// functions over the browser layer's element list, so the same label and
// heading rule applies that recording used. No Playwright here.

import type { PageElement } from "../browser.js";
import { CURRENCY } from "../steps.js";
import type { Condition, Locator, Target } from "../workflow/schema.js";

export function matches(element: PageElement, locator: Locator): boolean {
  const { info, node } = element;
  return (
    (locator.role === undefined || info.role === locator.role) &&
    (locator.name === undefined || info.name === locator.name) &&
    (locator.label === undefined || info.label === locator.label) &&
    (locator.text === undefined || node.text?.trim() === locator.text) &&
    (locator.within === undefined || info.heading === locator.within)
  );
}

export function countMatches(elements: PageElement[], locator: Locator): number {
  return elements.filter((e) => matches(e, locator)).length;
}

export type Resolution =
  | { ok: true; element: PageElement; ref: string; used: "primary" | { fallback: number } }
  | { ok: false; problem: "TARGET_NOT_FOUND" | "AMBIGUOUS_TARGET"; observed: string };

// Exactly one element, or nothing (D-047 R5). A fallback is tried only when
// the primary matches nothing, and must itself match exactly one. More than
// one match is never hidden by trying another locator.
export function resolveTarget(elements: PageElement[], target: Target): Resolution {
  const locators = [target.primary, ...target.fallbacks];
  for (const [i, locator] of locators.entries()) {
    const found = elements.filter((e) => matches(e, locator));
    const which = i === 0 ? "primary" : `fallback ${i}`;
    if (found.length > 1) return { ok: false, problem: "AMBIGUOUS_TARGET", observed: `${which} locator matched ${found.length} elements` };
    if (found.length === 1) {
      if (!found[0]!.ref) return { ok: false, problem: "TARGET_NOT_FOUND", observed: `${which} locator matched an element that cannot be acted on` };
      return { ok: true, element: found[0]!, ref: found[0]!.ref, used: i === 0 ? "primary" : { fallback: i } };
    }
  }
  return { ok: false, problem: "TARGET_NOT_FOUND", observed: `no locator matched (primary and ${target.fallbacks.length} fallback(s))` };
}

export interface ConditionContext {
  path: string;
  elements: PageElement[];
  inputs: Record<string, string>;
  outputs: Map<string, { value: string; target: Target }>; // read during this replay
}

export function holds(condition: Condition, ctx: ConditionContext): boolean {
  if ("path" in condition) return ctx.path === condition.path;
  if ("visible" in condition) return countMatches(ctx.elements, condition.visible) === 1;
  if ("gone" in condition) return countMatches(ctx.elements, condition.gone) === 0;
  if ("inputShown" in condition) {
    const value = ctx.inputs[condition.inputShown]?.trim();
    return Boolean(value) && ctx.elements.some((e) => e.info.role !== "textbox" && e.node.text?.trim() === value);
  }
  if ("outputShown" in condition) {
    // The element it was read from must still show the same value.
    const output = ctx.outputs.get(condition.outputShown);
    if (!output) return false;
    const where = resolveTarget(ctx.elements, output.target);
    return where.ok && where.element.node.text?.trim() === output.value;
  }
  const output = ctx.outputs.get(condition.outputFormat.output);
  return Boolean(output) && CURRENCY.test(output!.value);
}

export const allHold = (conditions: Condition[], ctx: ConditionContext): boolean => conditions.every((c) => holds(c, ctx));

// Plain description of a condition for failure evidence. Input and output
// values are never included, only their names.
export function describeCondition(condition: Condition): string {
  if ("path" in condition) return `page is ${condition.path}`;
  if ("visible" in condition) return `exactly one ${describeLocator(condition.visible)} is shown`;
  if ("gone" in condition) return `no ${describeLocator(condition.gone)} is shown`;
  if ("inputShown" in condition) return `input ${condition.inputShown} is shown on the page`;
  if ("outputShown" in condition) return `output ${condition.outputShown} is still shown where it was read`;
  return `output ${condition.outputFormat.output} looks like an amount`;
}

export function describeLocator(l: Locator): string {
  const parts = [
    l.role ?? "element",
    l.name !== undefined ? `named "${l.name}"` : "",
    l.label !== undefined ? `after "${l.label}"` : "",
    l.text !== undefined ? `with text "${l.text}"` : "",
    l.within !== undefined ? `in "${l.within}"` : "",
  ];
  return parts.filter(Boolean).join(" ");
}
