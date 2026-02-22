/**
 * Qwen OAuth provider for ApexClaw.
 *
 * Reads Qwen Code CLI OAuth credentials from ~/.qwen/oauth_creds.json
 * (shared with the Qwen CLI tool) and provides an OpenAI-compatible
 * interface to Qwen's cloud models.
 *
 * Free tier: 1,000-2,000 requests/day, 60 req/min, no token limit.
 * Models: qwen3-coder-plus, qwen3-coder-flash, qwen3-max, qwen-plus-latest
 *
 * If no cached tokens exist, runs OAuth Device Flow (RFC 8628) to
 * authenticate via browser — one-time setup, tokens auto-refresh.
 *
 * Usage in the fleet:
 *   - Replaces/supplements the Coder node for RBI code gen tasks
 *   - qwen3-coder-plus is a cloud model — no local GPU needed
 *   - 1,000+ free requests/day covers most RBI pipeline needs
 *   - Falls back to local Qwen Coder 7B if quota exhausted
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Qwen OAuth credential format (stored in ~/.qwen/oauth_creds.json) */
export type QwenOAuthCredentials = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  /** Unix timestamp (seconds) when access_token expires */
  expires_at: number;
  /** Scope of the token */
  scope?: string;
};

export type QwenProviderConfig = {
  /** Path to OAuth credentials file (default ~/.qwen/oauth_creds.json) */
  credentialsPath: string;
  /** API base URL (default https://dashscope.aliyuncs.com/compatible-mode/v1) */
  apiBaseUrl: string;
  /** OAuth token endpoint for Device Flow */
  tokenEndpoint: string;
  /** OAuth device authorization endpoint */
  deviceAuthEndpoint: string;
  /** OAuth client ID for Qwen Code */
  clientId: string;
  /** Refresh token this many seconds before expiry (default 30) */
  refreshBeforeExpirySec: number;
  /** Max requests per minute (default 55 — leave headroom below 60 limit) */
  maxRequestsPerMinute: number;
  /** Max daily requests (default 950 — leave headroom below 1000 limit) */
  maxDailyRequests: number;
};

const DEFAULT_CONFIG: QwenProviderConfig = {
  credentialsPath: join(homedir(), ".qwen", "oauth_creds.json"),
  apiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  tokenEndpoint: "https://chat.qwen.ai/api/v1/oauth/token",
  deviceAuthEndpoint: "https://chat.qwen.ai/api/v1/oauth/device/code",
  clientId: "qwen-code",
  refreshBeforeExpirySec: 30,
  maxRequestsPerMinute: 55,
  maxDailyRequests: 950,
};

/** Available Qwen cloud models via OAuth */
export const QWEN_CLOUD_MODELS = {
  /** Best coding model — use for RBI research, implement, backtest code gen */
  coderPlus: "qwen3-coder-plus",
  /** Faster coding model — use for quick code tasks */
  coderFlash: "qwen3-coder-flash",
  /** General purpose large model */
  max: "qwen3-max",
  /** General purpose — latest version */
  plusLatest: "qwen-plus-latest",
} as const;

export type QwenCloudModel = (typeof QWEN_CLOUD_MODELS)[keyof typeof QWEN_CLOUD_MODELS];

/** Rate limiter state */
type RateLimiter = {
  minuteWindow: number[];
  dailyCount: number;
  dailyResetAt: number;
};

export class QwenOAuthProvider {
  private config: QwenProviderConfig;
  private credentials: QwenOAuthCredentials | null = null;
  private rateLimiter: RateLimiter = {
    minuteWindow: [],
    dailyCount: 0,
    dailyResetAt: this.nextMidnightUtc(),
  };
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stats = {
    totalRequests: 0,
    todayRequests: 0,
    errors: 0,
    tokenRefreshes: 0,
    rateLimitHits: 0,
  };

  constructor(config?: Partial<QwenProviderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the provider: load or acquire OAuth tokens.
   * Call this once at startup. Returns true if authenticated.
   */
  async initialize(): Promise<boolean> {
    // Try to load existing credentials from disk
    this.credentials = this.loadCredentials();

    if (this.credentials) {
      // Check if token needs refresh
      if (this.isTokenExpiringSoon()) {
        const refreshed = await this.refreshToken();
        if (!refreshed) {
          // Token refresh failed — need to re-auth
          this.credentials = null;
        }
      }
    }

    if (this.credentials) {
      this.scheduleRefresh();
      return true;
    }

    // No valid credentials — need OAuth Device Flow
    return false;
  }

  /**
   * Run OAuth Device Flow for initial authentication.
   * Opens a browser for the user to authorize, then polls for completion.
   * Returns true on success.
   */
  async authenticate(): Promise<{
    success: boolean;
    userCode?: string;
    verificationUrl?: string;
    error?: string;
  }> {
    try {
      // Step 1: Request device code
      const deviceResponse = await fetch(this.config.deviceAuthEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.config.clientId,
          scope: "openid",
        }),
      });

      if (!deviceResponse.ok) {
        return { success: false, error: `Device auth request failed: HTTP ${deviceResponse.status}` };
      }

      const deviceData = await deviceResponse.json() as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
        expires_in: number;
        interval: number;
      };

      const verificationUrl = deviceData.verification_uri_complete ?? deviceData.verification_uri;

      // Step 2: Poll for token (user needs to authorize in browser)
      const token = await this.pollForToken(
        deviceData.device_code,
        deviceData.interval,
        deviceData.expires_in,
      );

      if (token) {
        this.credentials = token;
        this.saveCredentials(token);
        this.scheduleRefresh();
        return { success: true, userCode: deviceData.user_code, verificationUrl };
      }

      return { success: false, userCode: deviceData.user_code, verificationUrl, error: "Authorization timed out" };
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) };
    }
  }

  /**
   * Make an inference call to Qwen's cloud API.
   * Uses the OAuth token for authentication, OpenAI-compatible format.
   */
  async chat(
    model: QwenCloudModel,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
    },
  ): Promise<{
    text: string;
    model: string;
    tokensUsed: number;
    latencyMs: number;
  }> {
    if (!this.credentials) {
      throw new Error("Not authenticated. Call initialize() or authenticate() first.");
    }

    // Rate limiting
    if (!this.checkRateLimit()) {
      this.stats.rateLimitHits++;
      throw new Error(
        `Rate limit reached (${this.rateLimiter.dailyCount}/${this.config.maxDailyRequests} daily, ` +
        `${this.rateLimiter.minuteWindow.length}/${this.config.maxRequestsPerMinute} per minute)`,
      );
    }

    // Refresh token if needed
    if (this.isTokenExpiringSoon()) {
      await this.refreshToken();
    }

    const startTime = Date.now();

    const response = await fetch(`${this.config.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.credentials.access_token}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0.1,
        max_tokens: options?.maxTokens ?? 4096,
        stream: false,
      }),
      signal: AbortSignal.timeout(options?.timeoutMs ?? 60_000),
    });

    if (!response.ok) {
      this.stats.errors++;
      const errorText = await response.text().catch(() => "");
      throw new Error(`Qwen API error: HTTP ${response.status} — ${errorText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    const latencyMs = Date.now() - startTime;

    this.recordRequest();
    this.stats.totalRequests++;
    this.stats.todayRequests++;

    return {
      text,
      model,
      tokensUsed: data.usage?.total_tokens ?? Math.ceil(text.length / 4),
      latencyMs,
    };
  }

  /** Check if authenticated and tokens are valid */
  isAuthenticated(): boolean {
    return this.credentials !== null && !this.isTokenExpired();
  }

  /** Get remaining daily quota */
  getRemainingQuota(): { daily: number; perMinute: number } {
    this.resetDailyCounterIfNeeded();
    this.pruneMinuteWindow();
    return {
      daily: Math.max(0, this.config.maxDailyRequests - this.rateLimiter.dailyCount),
      perMinute: Math.max(0, this.config.maxRequestsPerMinute - this.rateLimiter.minuteWindow.length),
    };
  }

  /** Get provider stats for the dashboard */
  getStats(): {
    authenticated: boolean;
    totalRequests: number;
    todayRequests: number;
    errors: number;
    tokenRefreshes: number;
    rateLimitHits: number;
    remainingDaily: number;
    remainingPerMinute: number;
    tokenExpiresAt: number | null;
  } {
    const quota = this.getRemainingQuota();
    return {
      authenticated: this.isAuthenticated(),
      ...this.stats,
      remainingDaily: quota.daily,
      remainingPerMinute: quota.perMinute,
      tokenExpiresAt: this.credentials?.expires_at ?? null,
    };
  }

  /** Stop the auto-refresh timer */
  stop(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // --- Internal: Token Management ---

  private loadCredentials(): QwenOAuthCredentials | null {
    try {
      if (!existsSync(this.config.credentialsPath)) return null;
      const raw = readFileSync(this.config.credentialsPath, "utf-8");
      const creds = JSON.parse(raw) as QwenOAuthCredentials;
      if (!creds.access_token || !creds.refresh_token) return null;
      return creds;
    } catch {
      return null;
    }
  }

  private saveCredentials(creds: QwenOAuthCredentials): void {
    try {
      const dir = join(homedir(), ".qwen");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.config.credentialsPath, JSON.stringify(creds, null, 2), "utf-8");
    } catch {
      // Non-fatal — token still works in memory
    }
  }

  private isTokenExpired(): boolean {
    if (!this.credentials) return true;
    return Date.now() / 1000 >= this.credentials.expires_at;
  }

  private isTokenExpiringSoon(): boolean {
    if (!this.credentials) return true;
    return Date.now() / 1000 >= this.credentials.expires_at - this.config.refreshBeforeExpirySec;
  }

  private async refreshToken(): Promise<boolean> {
    if (!this.credentials?.refresh_token) return false;

    try {
      const response = await fetch(this.config.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: this.config.clientId,
          refresh_token: this.credentials.refresh_token,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return false;

      const data = await response.json() as QwenOAuthCredentials;
      if (!data.access_token) return false;

      // Compute expires_at if not provided
      if (!data.expires_at && data.expires_in) {
        data.expires_at = Math.floor(Date.now() / 1000) + data.expires_in;
      }

      this.credentials = data;
      this.saveCredentials(data);
      this.stats.tokenRefreshes++;
      this.scheduleRefresh();
      return true;
    } catch {
      return false;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.credentials) return;

    const refreshAt = (this.credentials.expires_at - this.config.refreshBeforeExpirySec) * 1000;
    const delay = Math.max(refreshAt - Date.now(), 60_000); // At least 1 min

    this.refreshTimer = setTimeout(() => {
      this.refreshToken().catch(() => {});
    }, delay);
  }

  private async pollForToken(
    deviceCode: string,
    intervalSec: number,
    expiresInSec: number,
  ): Promise<QwenOAuthCredentials | null> {
    const deadline = Date.now() + expiresInSec * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalSec * 1000);

      try {
        const response = await fetch(this.config.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: this.config.clientId,
            device_code: deviceCode,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          const data = await response.json() as QwenOAuthCredentials;
          if (data.access_token) {
            if (!data.expires_at && data.expires_in) {
              data.expires_at = Math.floor(Date.now() / 1000) + data.expires_in;
            }
            return data;
          }
        }

        // Check for known "not yet authorized" responses
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (body.error === "authorization_pending" || body.error === "slow_down") {
          if (body.error === "slow_down") intervalSec += 1;
          continue;
        }

        // Any other error means the flow failed
        if (body.error && body.error !== "authorization_pending") {
          return null;
        }
      } catch {
        // Network error — keep polling
      }
    }

    return null;
  }

  // --- Internal: Rate Limiting ---

  private checkRateLimit(): boolean {
    this.resetDailyCounterIfNeeded();
    this.pruneMinuteWindow();

    if (this.rateLimiter.dailyCount >= this.config.maxDailyRequests) return false;
    if (this.rateLimiter.minuteWindow.length >= this.config.maxRequestsPerMinute) return false;
    return true;
  }

  private recordRequest(): void {
    this.rateLimiter.minuteWindow.push(Date.now());
    this.rateLimiter.dailyCount++;
  }

  private pruneMinuteWindow(): void {
    const oneMinuteAgo = Date.now() - 60_000;
    this.rateLimiter.minuteWindow = this.rateLimiter.minuteWindow.filter((t) => t > oneMinuteAgo);
  }

  private resetDailyCounterIfNeeded(): void {
    if (Date.now() >= this.rateLimiter.dailyResetAt) {
      this.rateLimiter.dailyCount = 0;
      this.stats.todayRequests = 0;
      this.rateLimiter.dailyResetAt = this.nextMidnightUtc();
    }
  }

  private nextMidnightUtc(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.getTime();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
