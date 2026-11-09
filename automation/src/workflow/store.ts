// Workflow storage (D-013, D-044): capabilities/<name>/<version>.json.
// Versions are immutable: a new recording is the next patch version, and
// files are created with "fail if it exists", so nothing is overwritten.
// Draft/reusable status lives in one small status.json per workflow;
// Module 3 only ever writes "draft". Module 4 promotes after a test replay;
// promotion edits status.json only, never the workflow file.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RecordingRefused } from "./read-run.js";
import { WORKFLOW_NAME, Workflow, workflowProblems } from "./schema.js";

const VERSION_FILE = /^(\d+)\.(\d+)\.(\d+)\.json$/;
export const WorkflowStatus = z.record(z.string().regex(/^\d+\.\d+\.\d+$/), z.enum(["draft", "reusable"]));
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

export function versionsOf(capabilitiesDir: string, name: string): string[] {
  const dir = path.join(capabilitiesDir, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => f.match(VERSION_FILE))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    .map((v) => v.join("."));
}

// Simple patch increment from the highest existing version (D-013, approved).
export function nextVersion(existing: string[]): string {
  const last = existing.at(-1);
  if (!last) return "1.0.0";
  const [major, minor, patch] = last.split(".").map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

export function saveDraft(capabilitiesDir: string, draft: Omit<Workflow, "version">): { version: string; file: string } {
  if (!WORKFLOW_NAME.test(draft.name)) throw new RecordingRefused(`Invalid workflow name "${draft.name}".`);
  const version = nextVersion(versionsOf(capabilitiesDir, draft.name));
  // Fixed key order with version after name, so files read top-down.
  const { schemaVersion, name, ...rest } = draft;
  const parsed = Workflow.safeParse({ schemaVersion, name, version, ...rest });
  if (!parsed.success) throw new RecordingRefused(`Refusing to save an invalid workflow: ${workflowProblems(parsed.error)}`);

  const dir = path.join(capabilitiesDir, draft.name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${version}.json`);
  writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`, { flag: "wx" });

  const status = readStatus(capabilitiesDir, draft.name);
  status[version] = "draft";
  writeFileSync(path.join(dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  return { version, file };
}

export function readStatus(capabilitiesDir: string, name: string): WorkflowStatus {
  const file = path.join(capabilitiesDir, name, "status.json");
  if (!existsSync(file)) return {};
  const parsed = WorkflowStatus.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new RecordingRefused(`${name}/status.json is malformed.`);
  return parsed.data;
}

// Load one version, refusing anything malformed, unsupported or misfiled.
export function loadWorkflow(capabilitiesDir: string, name: string, version: string): Workflow {
  const file = path.join(capabilitiesDir, name, `${version}.json`);
  if (!existsSync(file)) throw new RecordingRefused(`No workflow ${name} version ${version}.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new RecordingRefused(`${name}/${version}.json is not valid JSON.`);
  }
  const parsed = Workflow.safeParse(raw);
  if (!parsed.success) throw new RecordingRefused(`${name}/${version}.json is not a valid workflow: ${workflowProblems(parsed.error)}`);
  if (parsed.data.name !== name || parsed.data.version !== version) {
    throw new RecordingRefused(`${name}/${version}.json names ${parsed.data.name} ${parsed.data.version}; the file is misplaced or edited.`);
  }
  return parsed.data;
}

// Version to replay (D-047 R3): the one named, or else the highest reusable
// one. A draft runs only when named explicitly.
export function selectVersion(capabilitiesDir: string, name: string, version?: string): string {
  const versions = versionsOf(capabilitiesDir, name);
  if (versions.length === 0) throw new RecordingRefused(`No recorded workflow named ${name}.`);
  if (version) {
    if (!versions.includes(version)) throw new RecordingRefused(`${name} has no version ${version} (has ${versions.join(", ")}).`);
    return version;
  }
  const status = readStatus(capabilitiesDir, name);
  const reusable = versions.filter((v) => status[v] === "reusable");
  if (reusable.length === 0) {
    const listed = versions.map((v) => `${v} (${status[v] ?? "draft"})`).join(", ");
    throw new RecordingRefused(
      `${name} has no reusable version yet: ${listed}. Select a draft explicitly with --version to verify it.`,
    );
  }
  return reusable.at(-1)!;
}

// Mark a draft reusable. The caller must have a successful replay of exactly
// this version; the workflow file itself is not touched.
export function promote(capabilitiesDir: string, name: string, version: string): { from: "draft"; to: "reusable" } {
  loadWorkflow(capabilitiesDir, name, version); // still valid and in place
  const status = readStatus(capabilitiesDir, name);
  if ((status[version] ?? "draft") !== "draft") throw new RecordingRefused(`${name} ${version} is already ${status[version]}.`);
  status[version] = "reusable";
  writeFileSync(path.join(capabilitiesDir, name, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  return { from: "draft", to: "reusable" };
}
