// Member data access for the mock bank.
// The page only ever receives the "safe to show" view built here: balances for
// restricted or closed accounts, and account numbers for restricted accounts,
// never leave the server.

import { readFileSync } from "node:fs";

export type AccountType = "savings" | "checking";

type AccountStatus = "active" | "restricted" | "closed";

interface AccountRecord {
  accountNumber: string;
  balance: number;
  status: AccountStatus;
}

export interface MemberRecord {
  memberId: string;
  memberName: string;
  savings: AccountRecord | null;
  checking: AccountRecord | null;
}

interface AccountViewBase {
  memberId: string;
  accountType: AccountType;
  accountName: string;
}

export type AccountView =
  | (AccountViewBase & { state: "active"; accountNumberMasked: string; status: "Active"; balance: string })
  | (AccountViewBase & { state: "closed"; accountNumberMasked: string; status: "Closed" })
  | (AccountViewBase & { state: "not_on_file"; message: string })
  | (AccountViewBase & { state: "permission_denied"; message: string });

const MEMBER_ID_PATTERN = /^\d{5}$/;

const ACCOUNT_NAMES: Record<AccountType, string> = {
  savings: "Savings Account",
  checking: "Checking Account",
};

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function isValidMemberId(value: string): boolean {
  return MEMBER_ID_PATTERN.test(value);
}

export function isAccountType(value: string): value is AccountType {
  return value === "savings" || value === "checking";
}

export function loadMembers(filePath: string): Map<string, MemberRecord> {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { members?: MemberRecord[] };
  if (!Array.isArray(parsed.members)) {
    throw new Error(`Member data file has no "members" array: ${filePath}`);
  }
  return new Map(parsed.members.map((member) => [member.memberId, member]));
}

function maskAccountNumber(accountNumber: string): string {
  return `••••${accountNumber.slice(-4)}`;
}

export function buildAccountView(member: MemberRecord, accountType: AccountType): AccountView {
  const base: AccountViewBase = {
    memberId: member.memberId,
    accountType,
    accountName: ACCOUNT_NAMES[accountType],
  };
  const account = member[accountType];

  if (account === null) {
    return { ...base, state: "not_on_file", message: `No ${accountType} account on file.` };
  }
  switch (account.status) {
    case "restricted":
      return { ...base, state: "permission_denied", message: "You do not have permission to view this account." };
    case "closed":
      return { ...base, state: "closed", accountNumberMasked: maskAccountNumber(account.accountNumber), status: "Closed" };
    case "active":
      return {
        ...base,
        state: "active",
        accountNumberMasked: maskAccountNumber(account.accountNumber),
        status: "Active",
        balance: currency.format(account.balance),
      };
  }
}
