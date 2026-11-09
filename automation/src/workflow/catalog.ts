// Known conditions of the mock bank (D-044): input formats, interruptions
// and business outcomes, each taken from documented Module 1 behavior or a
// verified live observation, and each citing its source. The recorder adds
// these to a workflow; it never invents rules from a single run.
// For another bank (tenant) this is the file that changes, not the recorder.

import type { BusinessOutcomeRule, ConditionalStep } from "./schema.js";
import type { LoggedStep } from "./read-run.js";

export const INPUT_FORMATS: Record<string, { pattern: string; description: string; source: string }> = {
  member_id: {
    pattern: "^\\d{5}$",
    description: "The member's 5-digit member ID.",
    source: 'Module 1 member search accepts exact 5-digit IDs only (D-033 E-11; message "Enter a valid 5-digit member ID.")',
  },
};

// Account sections on the Member Details page (D-031); outcome rules below
// apply only to outputs read in one of these.
const ACCOUNT_SECTIONS = ["Savings Account", "Checking Account"];

const NOTICE_HEADING = "System Notice";
const ACKNOWLEDGE = { role: "button", name: "Acknowledge" };

// Popup acknowledgement observed in a run → becomes a conditional step.
export function isNoticeAcknowledgement(step: LoggedStep): boolean {
  return (
    step.kind === "click" &&
    step.target?.role === ACKNOWLEDGE.role &&
    step.target.name === ACKNOWLEDGE.name &&
    step.target.heading === NOTICE_HEADING
  );
}

// "Loading <account>…" wait observed in a run → becomes a conditional step.
export function isLoadingWait(step: LoggedStep): boolean {
  return step.kind === "wait_for" && step.waitFor?.state === "hidden" && /^Loading [a-z ]+…$/.test(step.waitFor.text);
}

export function conditionalSteps(
  outputSections: string[],
  seen: { notice: boolean; loading: boolean; sessionExpired: boolean },
): ConditionalStep[] {
  const steps: ConditionalStep[] = [
    {
      id: "system_notice",
      description: "Acknowledge the System Notice popup when it covers the page.",
      // The page view gives the dialog itself no name: "System Notice" is
      // the heading inside it (D-049). A heading cannot be scoped to its own
      // section, so the heading and its Acknowledge button must both show.
      when: [
        { visible: { role: "heading", name: NOTICE_HEADING } },
        { visible: { ...ACKNOWLEDGE, within: NOTICE_HEADING } },
      ],
      action: {
        kind: "click",
        target: {
          primary: { ...ACKNOWLEDGE, within: NOTICE_HEADING },
          fallbacks: [],
          why: 'The popup\'s only button, found by role and name in the section headed "System Notice" (the dialog\'s own heading).',
        },
      },
      maxTimes: 2,
      source: "E-10 (D-036): appears each time member details load when BANK_NOTICE=on",
      seenInSourceRun: seen.notice,
    },
    {
      id: "session_expired",
      description: "When sent back to the login page with \"Session expired\", log in again and restart the main steps.",
      when: [{ path: "/login" }, { visible: { text: "Session expired. Please log in again." } }],
      action: { kind: "login_and_restart" },
      maxTimes: 1,
      source: "E-7 (D-036) and D-030: a not-logged-in response returns to login with \"Session expired\"",
      seenInSourceRun: seen.sessionExpired,
    },
    {
      id: "server_error_page",
      description: "Stop with a failure on the bank's error page.",
      when: [{ visible: { role: "heading", name: "Something went wrong" } }],
      action: { kind: "fail", reason: "The bank showed its error page." },
      maxTimes: 1,
      source: "E-9 (D-036): server error on search shows \"Something went wrong\"",
      seenInSourceRun: false,
    },
  ];
  for (const section of unique(outputSections.filter((s) => ACCOUNT_SECTIONS.includes(s)))) {
    const slug = section.toLowerCase().replace(/\W+/g, "_");
    steps.push(
      {
        id: `loading_${slug}`,
        description: `Wait while the ${section.toLowerCase()} is loading.`,
        when: [{ visible: { text: `Loading ${section.toLowerCase()}…`, within: section } }],
        action: { kind: "wait_until", until: { gone: { text: `Loading ${section.toLowerCase()}…`, within: section } }, timeoutSeconds: 15 },
        maxTimes: 1,
        source: "E-8 (D-036) and D-030: account details show a loading message naming the account",
        seenInSourceRun: seen.loading,
      },
      {
        id: `load_error_${slug}`,
        description: `Stop with a failure when the ${section.toLowerCase()} details cannot be loaded.`,
        when: [{ visible: { text: "Unable to load account details. Please try again.", within: section } }],
        action: { kind: "fail", reason: "The account details could not be loaded." },
        maxTimes: 1,
        source: "E-9 (D-036): a failed account request shows this message",
        seenInSourceRun: false,
      },
    );
  }
  return steps;
}

// Business outcomes that apply to a workflow. Member-level outcomes apply
// when the member ID is an input. Account-level ones apply per output
// section. A closed account is a business outcome only when no output
// reports the account's status: then "Closed" is a value, not an outcome
// (lead engineer's decision for Verify Checking Account, 2026-10-30).
export function businessOutcomes(inputs: string[], outputs: { section: string; label?: string }[]): BusinessOutcomeRule[] {
  const rules: BusinessOutcomeRule[] = [];
  if (inputs.includes("member_id")) {
    rules.push(
      {
        code: "NOT_FOUND",
        when: [{ visible: { text: "Member not found.", within: "Member Search" } }],
        message: "Member not found.",
        source: "Module 1 member search page message; seen in live run 7",
      },
      {
        code: "INVALID_INPUT",
        when: [{ visible: { text: "Enter a valid 5-digit member ID.", within: "Member Search" } }],
        message: "Enter a valid 5-digit member ID.",
        source: "Module 1 member search validation: exact 5-digit IDs only (D-033 E-11)",
      },
    );
  }
  for (const section of unique(outputs.map((o) => o.section).filter((s) => ACCOUNT_SECTIONS.includes(s)))) {
    const kind = section.split(" ")[0]!.toLowerCase();
    rules.push(
      {
        code: "NO_ACCOUNT",
        when: [{ visible: { text: `No ${kind} account on file.`, within: section } }],
        message: `No ${kind} account on file.`,
        source: "D-031: account not on file",
      },
      {
        code: "PERMISSION_DENIED",
        when: [{ visible: { text: "You do not have permission to view this account.", within: section } }],
        message: "You do not have permission to view this account.",
        source: "D-031: restricted account; seen in live run 4",
      },
    );
    const reportsStatus = outputs.some((o) => o.section === section && o.label === "Status");
    if (!reportsStatus) {
      rules.push({
        code: "ACCOUNT_CLOSED",
        when: [{ visible: { label: "Status", text: "Closed", within: section } }],
        message: `The ${kind} account is closed.`,
        source: "D-031: closed account shows status \"Closed\" and no balance",
      });
    }
  }
  return rules;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
