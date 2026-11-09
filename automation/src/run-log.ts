// Run folder (D-039): runs/<runId>/run.jsonl (one log entry per line),
// result.json, and on failure a sanitized page snapshot (plus a screenshot
// only when that setting is on). Callers must pass already-redacted data.

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type LogListener = (entry: Record<string, unknown>) => void;

export class RunLog {
  private seq = 0;

  private constructor(
    readonly runId: string,
    readonly dir: string,
    private readonly listener?: LogListener,
  ) {}

  static create(runsDir: string, listener?: LogListener): RunLog {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    const runId = `${stamp}-${randomBytes(3).toString("hex")}`;
    const dir = path.resolve(runsDir, runId);
    mkdirSync(dir, { recursive: true });
    return new RunLog(runId, dir, listener);
  }

  write(type: string, data: Record<string, unknown> = {}): void {
    const entry = { ts: new Date().toISOString(), seq: ++this.seq, type, ...data };
    appendFileSync(path.join(this.dir, "run.jsonl"), `${JSON.stringify(entry)}\n`);
    try {
      this.listener?.(entry);
    } catch {
      // A display problem must not stop or corrupt the run; the file has the entry.
    }
  }

  // The run folder's own location is left out: it is a local absolute path,
  // and the folder (named by runId) is where the file already is.
  saveResult(result: object): void {
    writeFileSync(path.join(this.dir, "result.json"), `${JSON.stringify({ ...result, runDir: undefined }, null, 2)}\n`);
  }

  saveFailureSnapshot(text: string): void {
    writeFileSync(path.join(this.dir, "failure-snapshot.txt"), `${text}\n`);
  }

  saveFailureScreenshot(png: Buffer): void {
    writeFileSync(path.join(this.dir, "failure.png"), png);
  }

  // Other evidence, e.g. handoff-1.json. Returns the file name.
  saveFile(name: string, data: string | Buffer): string {
    writeFileSync(path.join(this.dir, path.basename(name)), data);
    return path.basename(name);
  }
}
