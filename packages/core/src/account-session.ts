import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCodexHome } from "./app-server-identity.js";
import type {
  AccountLoginCompletedNotification,
  AccountUpdatedNotification,
  AuthMode,
  CancelLoginAccountParams,
  CancelLoginAccountResponse,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  GetAuthStatusResponse,
  LoginAccountParams,
  LoginAccountResponse,
  LogoutAccountResponse,
  PlanType,
} from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type StoredAuthState =
  | { mode: "apikey"; apiKey: string }
  | {
      mode: "chatgptAuthTokens";
      accessToken: string;
      accountId: string;
      email: string | null;
      planType: PlanType;
    };

function normalizePlanType(value: unknown): PlanType {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  switch (normalized) {
    case "free":
    case "go":
    case "plus":
    case "pro":
    case "team":
    case "business":
    case "enterprise":
    case "edu":
    case "unknown":
      return normalized as PlanType;
    default:
      return "unknown";
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }

  const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractChatgptIdentity(accessToken: string): { email: string | null; planType: PlanType } {
  const payload = decodeJwtPayload(accessToken);
  const profile =
    payload?.profile && typeof payload.profile === "object"
      ? (payload.profile as Record<string, unknown>)
      : null;
  const openaiProfile =
    payload?.["https://api.openai.com/profile"] &&
    typeof payload["https://api.openai.com/profile"] === "object"
      ? (payload["https://api.openai.com/profile"] as Record<string, unknown>)
      : null;
  const authClaims =
    payload?.["https://api.openai.com/auth"] &&
    typeof payload["https://api.openai.com/auth"] === "object"
      ? (payload["https://api.openai.com/auth"] as Record<string, unknown>)
      : null;
  const email =
    typeof payload?.email === "string"
      ? payload.email
      : typeof openaiProfile?.email === "string"
        ? openaiProfile.email
        : typeof profile?.email === "string"
          ? profile.email
          : null;
  return {
    email,
    planType: normalizePlanType(authClaims?.chatgpt_plan_type),
  };
}

export function readStoredAuthState(): StoredAuthState | null {
  const authPath = resolve(resolveCodexHome(), "auth.json");
  if (!existsSync(authPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    if (!isRecord(parsed)) {
      return null;
    }

    const tokens = isRecord(parsed.tokens) ? parsed.tokens : null;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : null;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : null;
    if (accessToken && accountId) {
      const identity = extractChatgptIdentity(accessToken);
      return {
        mode: "chatgptAuthTokens",
        accessToken,
        accountId,
        email: identity.email,
        planType: identity.planType,
      };
    }

    const apiKey = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null;
    if (apiKey && apiKey.length > 0) {
      return {
        mode: "apikey",
        apiKey,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export class AccountSession {
  constructor(
    private authState: StoredAuthState | null,
    private readonly publish: (method: string, params: unknown) => Promise<void>
  ) {}

  async initialized(): Promise<void> {
    if (!this.authState) return;
    await this.publishAccountLoginCompleted({ loginId: null, success: true, error: null });
    await this.publishAccountUpdated();
  }

  read(_params: unknown): GetAccountResponse {
    const account =
      this.authState?.mode === "apikey"
        ? { type: "apiKey" as const }
        : this.authState?.mode === "chatgptAuthTokens" && this.authState.email
          ? {
              type: "chatgpt" as const,
              email: this.authState.email,
              planType: this.authState.planType,
            }
          : null;
    return {
      account,
      requiresOpenaiAuth: this.authState !== null,
    };
  }

  async loginStart(params: unknown): Promise<LoginAccountResponse> {
    const parsed = params as LoginAccountParams;
    switch (parsed?.type) {
      case "apiKey":
        this.authState = { mode: "apikey", apiKey: parsed.apiKey };
        await this.publishAccountLoginCompleted({
          loginId: null,
          success: true,
          error: null,
        });
        await this.publishAccountUpdated();
        return { type: "apiKey" };
      case "chatgptAuthTokens": {
        const identity = extractChatgptIdentity(parsed.accessToken);
        this.authState = {
          mode: "chatgptAuthTokens",
          accessToken: parsed.accessToken,
          accountId: parsed.chatgptAccountId,
          email: identity.email,
          planType:
            parsed.chatgptPlanType === null || parsed.chatgptPlanType === undefined
              ? identity.planType
              : normalizePlanType(parsed.chatgptPlanType),
        };
        await this.publishAccountLoginCompleted({
          loginId: null,
          success: true,
          error: null,
        });
        await this.publishAccountUpdated();
        return { type: "chatgptAuthTokens" };
      }
      case "chatgpt":
        throw new Error(
          "Interactive ChatGPT login is not supported by codapter; use chatgptAuthTokens instead."
        );
      default:
        throw new Error("Invalid account/login/start params");
    }
  }

  loginCancel(params: unknown): CancelLoginAccountResponse {
    const parsed = params as Partial<CancelLoginAccountParams>;
    if (typeof parsed?.loginId !== "string") {
      throw new Error("Invalid account/login/cancel params");
    }
    return { status: "notFound" };
  }

  async logout(): Promise<LogoutAccountResponse> {
    this.authState = null;
    await this.publishAccountUpdated();
    return {};
  }

  rateLimits(): GetAccountRateLimitsResponse {
    return {
      rateLimits: {
        limitId: null,
        limitName: null,
        normalModelSlug: null,
        individualLimit: null,
        spendControlReached: null,
        rateLimitReachedType: null,
        primary: null,
        secondary: null,
        credits: null,
        planType: null,
      },
      rateLimitsByLimitId: null,
    };
  }

  private get effectiveAuthMode(): AuthMode | null {
    if (!this.authState) {
      return null;
    }
    return this.authState.mode === "chatgptAuthTokens" ? "chatgpt" : this.authState.mode;
  }

  authStatus(params: unknown): GetAuthStatusResponse {
    const parsed = (params ?? {}) as { includeToken?: boolean | null } | null;
    const includeToken = Boolean(parsed?.includeToken);
    const authToken =
      !includeToken || !this.authState
        ? null
        : this.authState.mode === "apikey"
          ? this.authState.apiKey
          : this.authState.accessToken;
    return {
      authMethod: this.effectiveAuthMode,
      authToken,
      requiresOpenaiAuth: this.authState !== null,
    };
  }

  private currentAccountUpdatedNotification(): AccountUpdatedNotification {
    return {
      authMode: this.effectiveAuthMode,
      planType: this.authState?.mode === "chatgptAuthTokens" ? this.authState.planType : null,
    };
  }

  private async publishAccountLoginCompleted(
    payload: AccountLoginCompletedNotification
  ): Promise<void> {
    await this.publish("account/login/completed", payload);
  }

  private async publishAccountUpdated(): Promise<void> {
    await this.publish("account/updated", this.currentAccountUpdatedNotification());
  }
}
