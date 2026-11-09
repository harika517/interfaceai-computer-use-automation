// Mock bank back-office app (Module 1a + 1b failure settings).
// Automation must operate it through the visible UI only; nothing outside
// mock-bank/ may import this code or read its data file.

import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import { delay, describeFaults, readFaultSettings, serverErrorOn } from "./faults.js";
import { buildAccountView, isAccountType, isValidMemberId, loadMembers } from "./members.js";

declare module "express-session" {
  interface SessionData {
    username?: string;
    loginAt?: number;
  }
}

const bankRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(bankRoot, "..");

try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch {
  // No .env file: rely on variables already set in the environment.
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and set it.`);
    process.exit(1);
  }
  return value;
}

const PORT = Number(process.env.PORT ?? 4000);
const USERNAME = requiredEnv("MOCK_BANK_USERNAME");
const PASSWORD = requiredEnv("MOCK_BANK_PASSWORD");
const SESSION_SECRET = requiredEnv("SESSION_SECRET");
const SESSION_COOKIE = "bank.sid";

const members = loadMembers(path.join(bankRoot, "data", "members.json"));

let faults: ReturnType<typeof readFaultSettings>;
try {
  faults = readFaultSettings();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

// A session cookie without a live session means the session expired or was
// invalidated, as opposed to someone who never logged in.
function hadSessionCookie(req: Request): boolean {
  return (req.headers.cookie ?? "").split(";").some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

function requireLoginPage(req: Request, res: Response, next: NextFunction): void {
  if (req.session.username) return next();
  res.redirect(hadSessionCookie(req) ? "/login?reason=expired" : "/login");
}

function requireLoginData(req: Request, res: Response, next: NextFunction): void {
  if (req.session.username) return next();
  res.status(401).json({ error: "not_authenticated" });
}

const app = express();
app.disable("x-powered-by");
app.set("view engine", "ejs");
app.set("views", path.join(bankRoot, "views"));

app.use("/static", express.static(path.join(bankRoot, "public")));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    name: SESSION_COOKIE,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  }),
);
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// E-7: end the session a fixed time after login. The browser still sends the
// old cookie, so the login checks below report it as "Session expired".
app.use((req, _res, next) => {
  const loginAt = req.session.loginAt;
  if (!faults.sessionTtlSeconds || !req.session.username || loginAt === undefined) return next();
  if (Date.now() - loginAt < faults.sessionTtlSeconds * 1000) return next();
  req.session.regenerate((err) => next(err)); // fresh, empty session; never saved
});

app.get("/", (_req, res) => {
  res.redirect("/members");
});

app.get("/login", (req, res) => {
  if (req.session.username) return res.redirect("/members");
  const notice = req.query.reason === "expired" ? "Session expired. Please log in again." : null;
  res.render("login", { error: null, notice });
});

app.post("/login", (req, res, next) => {
  const username = String(req.body.username ?? "");
  const password = String(req.body.password ?? "");
  if (!sameSecret(username, USERNAME) || !sameSecret(password, PASSWORD)) {
    res.status(401).render("login", { error: "Invalid username or password.", notice: null });
    return;
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.username = username;
    req.session.loginAt = Date.now();
    res.redirect("/members");
  });
});

app.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie(SESSION_COOKIE);
    res.redirect("/login");
  });
});

app.get("/members", requireLoginPage, async (req, res) => {
  const query = req.query.memberId;
  const memberId = typeof query === "string" ? query.trim() : undefined;
  let error: string | null = null;
  let member = null;

  if (memberId !== undefined) {
    await delay(faults.slowMs); // E-8
    if (serverErrorOn(faults, "search")) {
      res.status(500).render("error"); // E-9
      return;
    }
    if (!isValidMemberId(memberId)) {
      error = "Enter a valid 5-digit member ID.";
    } else {
      member = members.get(memberId) ?? null;
      if (!member) error = "Member not found.";
    }
  }

  res.status(error === "Member not found." ? 404 : error ? 400 : 200);
  res.render("members", {
    searchedId: memberId ?? "",
    error,
    member: member && { memberId: member.memberId, memberName: member.memberName },
    showNotice: faults.notice && member !== null, // E-10
  });
});

app.get("/members/:memberId/accounts/:accountType", requireLoginData, async (req: Request<{ memberId: string; accountType: string }>, res) => {
  await delay(faults.slowMs); // E-8
  if (serverErrorOn(faults, "accounts")) {
    res.status(500).json({ error: "server_error" }); // E-9
    return;
  }
  const { memberId, accountType } = req.params;
  if (!isValidMemberId(memberId) || !isAccountType(accountType)) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const member = members.get(memberId);
  if (!member) {
    res.status(404).json({ error: "member_not_found" });
    return;
  }
  res.json(buildAccountView(member, accountType));
});

app.listen(PORT, () => {
  console.log(`Mock bank running at http://localhost:${PORT}`);
  console.log(describeFaults(faults));
});
