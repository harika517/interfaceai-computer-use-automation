// Controlled failure settings for the mock bank (Module 1b).
// They are read once from the environment at startup. No request, page or URL
// can switch them on, so automation cannot trigger or avoid them on its own.

export type ServerErrorTarget = "off" | "search" | "accounts" | "all";

export interface FaultSettings {
  /** End every session this many seconds after login (E-7). 0 = never. */
  sessionTtlSeconds: number;
  /** Delay member search pages and account requests by this many ms (E-8). 0 = off. */
  slowMs: number;
  /** Where to return a server error (E-9). */
  serverError: ServerErrorTarget;
  /** Show the "System Notice" popup on the Member Details page (E-10). */
  notice: boolean;
}

function nonNegativeInt(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number of 0 or more (got "${raw}").`);
  }
  return value;
}

export function readFaultSettings(): FaultSettings {
  const serverError = (process.env.BANK_SERVER_ERROR || "off") as ServerErrorTarget;
  if (!["off", "search", "accounts", "all"].includes(serverError)) {
    throw new Error(`BANK_SERVER_ERROR must be off, search, accounts or all (got "${serverError}").`);
  }
  const notice = process.env.BANK_NOTICE || "off";
  if (notice !== "on" && notice !== "off") {
    throw new Error(`BANK_NOTICE must be on or off (got "${notice}").`);
  }
  return {
    sessionTtlSeconds: nonNegativeInt("BANK_SESSION_TTL_SECONDS"),
    slowMs: nonNegativeInt("BANK_SLOW_MS"),
    serverError,
    notice: notice === "on",
  };
}

export function describeFaults(settings: FaultSettings): string {
  const active = [
    settings.sessionTtlSeconds > 0 && `session expires ${settings.sessionTtlSeconds}s after login`,
    settings.slowMs > 0 && `slow responses (${settings.slowMs} ms)`,
    settings.serverError !== "off" && `server error on ${settings.serverError}`,
    settings.notice && "system notice popup",
  ].filter(Boolean);
  return active.length ? `Failure settings ON: ${active.join("; ")}` : "Failure settings: none";
}

export function serverErrorOn(settings: FaultSettings, target: "search" | "accounts"): boolean {
  return settings.serverError === "all" || settings.serverError === target;
}

export function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
