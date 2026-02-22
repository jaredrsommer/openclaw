/**
 * Dashboard web server for ApexClaw fleet monitoring.
 *
 * Lightweight HTTP + WebSocket server that serves the dashboard UI and
 * streams real-time fleet state to connected browsers.
 *
 * Runs on the Queen node (Node 4) at the configured dashboardPort (default 3939).
 *
 * Endpoints:
 *   GET /              → Dashboard HTML
 *   GET /api/snapshot  → Full orchestrator state JSON
 *   GET /api/agents    → Agent list with routing info
 *   GET /api/fleet     → Fleet node statuses
 *   POST /api/command  → Send orchestrator commands (pause, resume, emergency-stop, rbi-start)
 *   WS /ws             → Real-time event stream
 */

import http from "node:http";
import { type QueenOrchestrator } from "./queen-orchestrator.js";
import { type FleetManager } from "./fleet-manager.js";
import { DASHBOARD_HTML } from "./dashboard-ui.js";

export type DashboardConfig = {
  port: number;
  host: string;
};

export function startDashboardServer(
  orchestrator: QueenOrchestrator,
  fleet: FleetManager,
  config: DashboardConfig = { port: 3939, host: "0.0.0.0" },
): http.Server {
  // Track WebSocket-like connections via SSE (Server-Sent Events)
  // Using SSE instead of raw WebSocket to avoid needing a ws library
  const sseClients: Set<http.ServerResponse> = new Set();

  // Subscribe to fleet events and forward to all SSE clients
  fleet.onEvent((event) => {
    const data = JSON.stringify(event);
    for (const client of sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // CORS headers for development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Routes
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (url.pathname === "/api/snapshot" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(orchestrator.getSnapshot()));
      return;
    }

    if (url.pathname === "/api/agents" && req.method === "GET") {
      const snapshot = orchestrator.getSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot.agents));
      return;
    }

    if (url.pathname === "/api/fleet" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(fleet.getStatus()));
      return;
    }

    if (url.pathname === "/api/command" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const cmd = JSON.parse(body) as { action: string; payload?: string };
          handleCommand(orchestrator, cmd.action, cmd.payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, state: orchestrator.getState() }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    // Server-Sent Events endpoint (real-time updates)
    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseClients.add(res);

      // Send initial snapshot
      res.write(`data: ${JSON.stringify({ type: "init", snapshot: orchestrator.getSnapshot() })}\n\n`);

      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(config.port, config.host, () => {
    console.log(`ApexClaw Dashboard: http://${config.host}:${config.port}`);
  });

  return server;
}

function handleCommand(orchestrator: QueenOrchestrator, action: string, payload?: string): void {
  switch (action) {
    case "pause":
      orchestrator.stop();
      break;
    case "resume":
      orchestrator.start();
      break;
    case "emergency-stop":
      orchestrator.emergencyStop(payload ?? "Manual emergency stop from dashboard");
      break;
    case "rbi-start":
      orchestrator.startRbiPipeline(payload ?? "User-initiated research");
      break;
    default:
      throw new Error(`Unknown command: ${action}`);
  }
}
