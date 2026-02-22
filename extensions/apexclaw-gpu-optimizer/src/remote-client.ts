/**
 * Remote control client for managing an ApexClaw fleet from a laptop.
 *
 * Your laptop doesn't run any GPU models. It connects to the fleet's
 * dashboard server (running on the Queen node) via HTTP and SSE.
 *
 * Three ways to control the fleet from your laptop:
 *
 *   1. Browser dashboard:  http://<queen-ip>:3939
 *   2. OpenClaw CLI:       apexclaw-trade action:status (proxies to Queen)
 *   3. This client:        Direct HTTP calls for scripting/automation
 */

export type RemoteFleetConfig = {
  /** IP/hostname of the Queen node (the one running the dashboard) */
  queenHost: string;
  /** Dashboard port on the Queen node (default 3939) */
  dashboardPort: number;
  /** Request timeout in ms */
  timeoutMs: number;
};

export const DEFAULT_REMOTE_CONFIG: RemoteFleetConfig = {
  queenHost: "192.168.1.102",
  dashboardPort: 3939,
  timeoutMs: 10000,
};

export class RemoteFleetClient {
  private baseUrl: string;

  constructor(private config: RemoteFleetConfig = DEFAULT_REMOTE_CONFIG) {
    this.baseUrl = `http://${config.queenHost}:${config.dashboardPort}`;
  }

  /** Check if the Queen node is reachable */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/fleet`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Get full orchestrator snapshot */
  async getSnapshot(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/snapshot`, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Get fleet status */
  async getFleetStatus(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/fleet`, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Get agent states */
  async getAgents(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/agents`, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Send a command to the orchestrator */
  async sendCommand(action: string, payload?: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Pause all trading */
  async pause(): Promise<unknown> {
    return this.sendCommand("pause");
  }

  /** Resume trading */
  async resume(): Promise<unknown> {
    return this.sendCommand("resume");
  }

  /** Emergency stop */
  async emergencyStop(reason: string): Promise<unknown> {
    return this.sendCommand("emergency-stop", reason);
  }

  /** Start an RBI research pipeline */
  async startRbi(hypothesis: string): Promise<unknown> {
    return this.sendCommand("rbi-start", hypothesis);
  }

  /** Get the dashboard URL to open in your browser */
  getDashboardUrl(): string {
    return this.baseUrl;
  }
}

/**
 * Helper to auto-discover the Queen node on the local network.
 * Tries a list of common LAN IPs on the dashboard port.
 */
export async function discoverQueenNode(
  dashboardPort = 3939,
  subnet = "192.168.1",
  startIp = 100,
  endIp = 110,
): Promise<string | null> {
  const candidates = [];
  for (let i = startIp; i <= endIp; i++) {
    candidates.push(`${subnet}.${i}`);
  }

  const checks = candidates.map(async (ip) => {
    try {
      const res = await fetch(`http://${ip}:${dashboardPort}/api/fleet`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return ip;
    } catch {
      // not this one
    }
    return null;
  });

  const results = await Promise.allSettled(checks);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}
