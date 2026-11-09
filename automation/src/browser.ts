// Browser layer (D-010): the only file that uses Playwright. It opens a
// visible browser, reports what is on screen as an accessibility snapshot
// with element references, and performs single UI steps. Anything else in
// the automation sees only the plain data shapes below.

import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page, type Request } from "playwright";

export interface PageNode {
  ref?: string;
  role: string;
  name?: string;
  text?: string;
  level?: number;
  pressed?: boolean;
  disabled?: boolean;
  secret?: boolean; // password box: its value is never reported
  filled?: boolean; // password box only: whether it holds a value (never the value itself)
  children?: PageNode[];
}

export interface PageView {
  url: string;
  path: string;
  nodes: PageNode[];
}

export interface ElementInfo {
  role: string;
  name?: string;
  text?: string; // visible text, for elements without a name
  label?: string; // text just before a nameless element, e.g. "Balance"
  heading?: string; // heading of the closest section containing it
}

const SETTLE_MS = 1500; // longest wait for in-flight requests after a step
const QUIET_MS = 200; // how long the network must stay quiet to count as settled
const NAVIGATION_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5_000;

// One element of the latest view with what describes it, including plain
// text that has no reference (e.g. "Member not found."). Replay finds its
// targets and checks its conditions in this list (D-047).
export interface PageElement {
  ref?: string;
  node: PageNode;
  info: ElementInfo;
}

// One action a person took in the browser during a handoff (D-051). Only
// what describes the element is reported, never a typed value.
export interface HumanEvent {
  kind: "click" | "input" | "submit" | "key" | "navigation";
  path: string; // page path only: the member page's query holds the member ID
  role?: string;
  name?: string; // accessible name or label of the element
  key?: string;
  secret?: boolean; // a password box
}

// Runs in the page. Reports trusted clicks, typing, form submits and
// Enter presses on interactive elements only; text that is not a control is
// never reported, and field values are never read. Guarded so one document
// never reports an event twice, however often it is installed.
const HUMAN_WATCH_SCRIPT = `(() => {
  if (window.__humanWatchInstalled) return;
  window.__humanWatchInstalled = true;
  const CONTROLS = 'button, a[href], input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem]';
  const short = (t) => (t || "").replace(/\\s+/g, " ").trim().slice(0, 80) || undefined;
  const roleOf = (el) => el.getAttribute("role") || { BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" }[el.tagName]
    || (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button" }[el.type] || "textbox") : el.tagName.toLowerCase());
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return short(aria);
    if (el.labels && el.labels.length > 0) return short(el.labels[0].textContent);
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return short(el.getAttribute("placeholder") || el.getAttribute("name"));
    return short(el.textContent);
  };
  const describe = (el) => ({ role: roleOf(el), name: nameOf(el), secret: el.type === "password" || undefined });
  const send = (event) => { try { window.__humanAction(event); } catch {} };
  const control = (target) => (target && target.closest ? target.closest(CONTROLS) : null);
  document.addEventListener("click", (e) => { const el = e.isTrusted && control(e.target); if (el) send({ kind: "click", ...describe(el) }); }, true);
  // "input" fires as the person types; "change" would fire later, on leaving
  // the field, and could blame them for a value automation typed earlier.
  document.addEventListener("input", (e) => { const el = e.isTrusted && control(e.target); if (el) send({ kind: "input", ...describe(el) }); }, true);
  document.addEventListener("submit", (e) => { if (e.isTrusted) send({ kind: "submit", ...(e.submitter ? describe(e.submitter) : { role: "form" }) }); }, true);
  document.addEventListener("keydown", (e) => { if (!e.isTrusted || e.key !== "Enter") return; const el = control(e.target); send({ kind: "key", key: "Enter", ...(el ? describe(el) : { role: "document" }) }); }, true);
})();`;

export class BrowserSession {
  // Identifies this one live browser and page in the log; there is no way
  // to reopen or swap the page, so the same id means the same session.
  readonly sessionId = randomUUID();
  private humanListener?: (event: HumanEvent) => void;
  private watchInstalled = false;
  private latest = new Map<string, { node: PageNode; info: ElementInfo }>();
  private all: PageElement[] = [];
  private readonly inFlight = new Set<Request>();

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {
    // Track requests ourselves: Playwright's "networkidle" only describes the
    // initial page load, not requests the page makes after a click. Each
    // request leaves the set when it finishes or fails, so navigations and
    // late replies from an old page cannot skew the count.
    page.on("request", (request) => this.inFlight.add(request));
    page.on("requestfinished", (request) => this.inFlight.delete(request));
    page.on("requestfailed", (request) => this.inFlight.delete(request));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.humanListener?.({ kind: "navigation", path: pathOf(frame.url()) });
    });
  }

  static async open(headless: boolean): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless });
    const page = await browser.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    return new BrowserSession(browser, page);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
    await this.settle();
  }

  url(): string {
    return this.page.url();
  }

  // Snapshot of the visible page. Password values are removed here, before
  // anything else can see them.
  async view(): Promise<PageView> {
    const raw = (await this.page.ariaSnapshotJSON({ mode: "ai" })) as unknown;
    const nodes = toNodes(raw);
    this.latest.clear();
    this.all = [];
    await this.markSecrets(nodes);
    const url = this.page.url();
    return { url, path: new URL(url).pathname, nodes };
  }

  // Role and name of an element from the latest view, if the reference exists.
  describe(ref: string): ElementInfo | undefined {
    return this.latest.get(ref)?.info;
  }

  // Every element of the latest view, in page order.
  elements(): PageElement[] {
    return this.all;
  }

  isSecret(ref: string): boolean {
    return this.latest.get(ref)?.node.secret === true;
  }

  async click(ref: string): Promise<void> {
    await this.page.getByRef(ref).click();
    await this.settle();
  }

  async fill(ref: string, value: string): Promise<void> {
    await this.page.getByRef(ref).fill(value);
  }

  async readText(ref: string): Promise<string> {
    return (await this.page.getByRef(ref).innerText()).trim();
  }

  async waitForText(text: string, state: "visible" | "hidden", timeoutMs: number): Promise<void> {
    await this.page.getByText(text).first().waitFor({ state, timeout: timeoutMs });
  }

  // Screenshot with the given elements painted over (D-041 #7).
  async screenshot(maskRefs: string[] = []): Promise<Buffer> {
    return this.page.screenshot({ mask: maskRefs.map((ref) => this.page.getByRef(ref)) });
  }

  // Elements of the latest view that must be painted over in a screenshot:
  // every text box (they hold inputs and credentials), values after sensitive
  // labels, and any element whose text matches one of the given values or
  // patterns.
  sensitiveRefs(sensitiveLabels: string[], values: string[], patterns: RegExp[] = []): string[] {
    const labels = sensitiveLabels.map((l) => l.trim().toLowerCase());
    const refs: string[] = [];
    for (const [ref, { node, info }] of this.latest) {
      const text = node.text ?? "";
      if (
        node.role === "textbox" ||
        node.secret ||
        (info.label && labels.includes(info.label.trim().toLowerCase())) ||
        values.some((v) => v && text.includes(v)) ||
        patterns.some((p) => p.test(text))
      ) {
        refs.push(ref);
      }
    }
    return refs;
  }

  async close(): Promise<void> {
    this.humanListener = undefined;
    await this.browser.close();
  }

  isOpen(): boolean {
    return this.browser.isConnected() && !this.page.isClosed();
  }

  // Calls `onLost` once if the person closes the window or the browser goes away.
  onLost(onLost: () => void): () => void {
    let fired = false;
    const fire = () => {
      if (!fired) {
        fired = true;
        onLost();
      }
    };
    this.page.on("close", fire);
    this.browser.on("disconnected", fire);
    return () => {
      this.page.off("close", fire);
      this.browser.off("disconnected", fire);
    };
  }

  // Report a person's actions in this page to `listener` until the returned
  // function is called (D-051). The page script and the bridge are installed
  // once per session, so repeated handoffs and navigations never duplicate
  // events; only one listener can be active at a time.
  async watchHuman(listener: (event: HumanEvent) => void): Promise<() => void> {
    if (this.humanListener) throw new Error("Already watching for a person's actions.");
    if (!this.watchInstalled) {
      await this.page.exposeBinding("__humanAction", (_source, raw: unknown) => {
        const event = toHumanEvent(raw, pathOf(this.page.url()));
        if (event) this.humanListener?.(event);
      });
      await this.page.addInitScript(HUMAN_WATCH_SCRIPT); // every later page
      this.watchInstalled = true;
    }
    await this.page.evaluate(HUMAN_WATCH_SCRIPT); // the page shown now
    this.humanListener = listener;
    return () => {
      if (this.humanListener === listener) this.humanListener = undefined;
    };
  }

  watchingHuman(): boolean {
    return this.humanListener !== undefined;
  }

  // The live page itself, for a simulated person in tests only. Automation
  // never uses it: every automated step goes through the methods above.
  livePageForTests(): Page {
    return this.page;
  }

  // After a step: wait for any whole-page navigation and load, then up to
  // SETTLE_MS for the page's own background requests. A page still loading
  // its data after that is left as is on purpose: the LLM sees its loading
  // message and decides to wait (E-8).
  private async settle(): Promise<void> {
    // A whole-page navigation (form submit, link) is always waited for.
    const navigationDeadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    while (this.pageNavigationPending() && Date.now() < navigationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await this.page.waitForLoadState("load");
    const deadline = Date.now() + SETTLE_MS;
    let quietSince = this.inFlight.size === 0 ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (this.inFlight.size > 0) quietSince = 0;
      else if (quietSince === 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= QUIET_MS) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private pageNavigationPending(): boolean {
    for (const request of this.inFlight) {
      try {
        if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) return true;
      } catch {
        // Requests without a frame (e.g. service workers) are not page navigations.
      }
    }
    return false;
  }

  // Index elements by reference (with label and section heading, so a
  // recorded step can say *which* text it read) and blank password values.
  private async markSecrets(nodes: PageNode[], heading?: string): Promise<void> {
    const sectionHeading = nodes.find((n) => n.role === "heading");
    const here = sectionHeading?.name ?? sectionHeading?.text ?? heading;
    for (const [i, node] of nodes.entries()) {
      if (node.ref && node.role === "textbox") {
        const type = await this.page.getByRef(node.ref).getAttribute("type").catch(() => null);
        if (type === "password") {
          node.secret = true;
          // Keep only whether something was typed, so a filled box differs
          // from an empty one; the value itself is dropped here.
          if (node.text) node.filled = true;
          delete node.text;
        }
      }
      // The same label and heading rule serves recording (via the log) and replay.
      const info: ElementInfo = { role: node.role, name: node.name };
      if (!node.name && node.text && !node.secret) info.text = node.text;
      const before = nodes[i - 1];
      if (!node.name && before?.text && !before.children) info.label = before.text;
      if (here && node !== sectionHeading) info.heading = here;
      if (node.ref) this.latest.set(node.ref, { node, info });
      this.all.push({ ref: node.ref, node, info });
      if (node.children) await this.markSecrets(node.children, here);
    }
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(unknown)";
  }
}

// Events come from page script, so they are checked like any outside input.
function toHumanEvent(raw: unknown, path: string): HumanEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!["click", "input", "submit", "key"].includes(String(r.kind))) return undefined;
  const text = (value: unknown, max: number) => (typeof value === "string" && value ? value.slice(0, max) : undefined);
  return {
    kind: r.kind as HumanEvent["kind"],
    path,
    role: text(r.role, 40),
    name: text(r.name, 80),
    key: r.key === "Enter" ? "Enter" : undefined,
    secret: r.secret === true ? true : undefined,
  };
}

function toNodes(raw: unknown): PageNode[] {
  if (!Array.isArray(raw)) return [];
  const nodes: PageNode[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      nodes.push({ role: "text", text: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const node: PageNode = { role: typeof r.role === "string" ? r.role : "generic" };
    if (typeof r.ref === "string") node.ref = r.ref;
    if (typeof r.name === "string" && r.name) node.name = r.name;
    if (typeof r.text === "string" && r.text) node.text = r.text;
    if (typeof r.level === "number") node.level = r.level;
    if (r.pressed === true) node.pressed = true;
    if (r.disabled === true) node.disabled = true;
    const children = toNodes(r.children);
    if (children.length > 0) node.children = children;
    nodes.push(node);
  }
  return nodes;
}
