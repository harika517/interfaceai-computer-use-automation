// "Who is in control" of the browser (D-012, D-051). One shared state per
// run: the shared step checkpoint runs an automated step only while
// automation is in control, and every change of control is logged with a
// new epoch, so the log shows exactly which steps ran under whose control.

import type { RunLog } from "./run-log.js";

export type Controller = "automation" | "human";

export interface ControlChange {
  at: string;
  from: Controller;
  to: Controller;
  epoch: number;
  reason: string;
}

export class ControlState {
  private current: Controller = "automation";
  private currentEpoch = 0;
  readonly history: ControlChange[] = [];

  constructor(private readonly log?: RunLog) {}

  get owner(): Controller {
    return this.current;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  transfer(to: Controller, reason: string): number {
    if (to === this.current) throw new Error(`Control is already with ${to}.`);
    const change: ControlChange = { at: new Date().toISOString(), from: this.current, to, epoch: ++this.currentEpoch, reason };
    this.current = to;
    this.history.push(change);
    this.log?.write("control_changed", { from: change.from, to, epoch: change.epoch, reason });
    return change.epoch;
  }
}
