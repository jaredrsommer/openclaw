/**
 * Dashboard web server for ApexClaw fleet monitoring.
 *
 * Lightweight HTTP + SSE server that serves the dashboard UI and
 * streams real-time fleet state + agent-to-agent comms to connected browsers.
 *
 * Runs on the dashboard host node at the configured dashboardPort (default 3939).
 *
 * Endpoints:
 *   GET /              → Dashboard HTML
 *   GET /api/snapshot  → Full orchestrator state JSON
 *   GET /api/agents    → Agent list with routing info
 *   GET /api/fleet     → Fleet node statuses
 *   GET /api/bus       → Message bus stats + recent messages
 *   GET /api/bus/topic/:topic → Messages for a specific topic
 *   GET /api/bus/agent/:id → Messages from/to a specific agent
 *   POST /api/command  → Send orchestrator commands (pause, resume, emergency-stop, rbi-start)
 *   GET /api/airllm/health → AirLLM server health (model, GPU, ramdisk status)
 *   GET /api/events    → SSE real-time event stream (fleet + agent comms)
 */

import http from "node:http";
import { type QueenOrchestrator } from "./queen-orchestrator.js";
import { type FleetManager } from "./fleet-manager.js";
import { DASHBOARD_HTML } from "./dashboard-ui.js";
import { ALL_AGENTS, getAgentDisplay, setAgentCustomName } from "./trading-agents.js";
import { AirLLMProvider } from "./airllm-provider.js";

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
    broadcast({ ...event, source: "fleet" });
  });

  // Subscribe to ALL bus messages and forward to SSE clients
  // The "*" wildcard topic catches every message on the bus
  orchestrator.bus.subscribe("queen", "*", (msg) => {
    broadcast({
      source: "bus",
      type: "bus-message",
      timestamp: msg.timestamp,
      id: msg.id,
      from: msg.from,
      to: msg.to,
      topic: msg.topic,
      msgType: msg.type,
      summary: msg.summary,
      hasPayload: msg.payload !== undefined,
      inReplyTo: msg.inReplyTo,
      chain: msg.chain,
    });
  });

  function broadcast(data: unknown): void {
    const json = JSON.stringify(data);
    for (const client of sseClients) {
      try {
        client.write(`data: ${json}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }

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

    // --- AirLLM health ---
    if (url.pathname === "/api/airllm/health" && req.method === "GET") {
      const airllmUrl = process.env.AIRLLM_URL ?? "http://localhost:8787";
      if (!process.env.AIRLLM_ENABLED) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "AirLLM not enabled" }));
        return;
      }
      const airllm = new AirLLMProvider({ serverUrl: airllmUrl });
      airllm.getHealth().then((health) => {
        if (health) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(health));
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "AirLLM server not reachable" }));
        }
      }).catch(() => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "AirLLM server not reachable" }));
      });
      return;
    }

    // --- Agent naming ---

    if (url.pathname === "/api/agents/names" && req.method === "GET") {
      const names: Record<string, { name: string; avatar: string }> = {};
      for (const agent of ALL_AGENTS) {
        names[agent.id] = getAgentDisplay(agent.id);
      }
      // Include "queen" which isn't in ALL_AGENTS
      names["queen"] = { name: "Queen", avatar: "QN" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(names));
      return;
    }

    if (url.pathname === "/api/agents/rename" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { agentId, customName } = JSON.parse(body) as { agentId: string; customName: string };
          if (!agentId || !customName) throw new Error("agentId and customName required");
          const ok = setAgentCustomName(agentId, customName);
          if (!ok) throw new Error(`Unknown agent: ${agentId}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, agentId, customName }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    // --- Message Bus API endpoints ---

    if (url.pathname === "/api/bus" && req.method === "GET") {
      const stats = orchestrator.bus.getStats();
      const recent = orchestrator.bus.getTopicHistory("*", 0); // no wildcard history, use all topics
      // Collect last 100 messages across all topics
      const allRecent: unknown[] = [];
      for (const topic of Object.keys(stats.topicCounts)) {
        allRecent.push(...orchestrator.bus.getTopicHistory(topic, 20));
      }
      allRecent.sort((a: any, b: any) => a.timestamp - b.timestamp);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        stats,
        recentMessages: allRecent.slice(-100),
      }));
      return;
    }

    // /api/bus/topic/:topic — messages for a specific topic (dot-separated)
    const topicMatch = url.pathname.match(/^\/api\/bus\/topic\/(.+)$/);
    if (topicMatch && req.method === "GET") {
      const topic = decodeURIComponent(topicMatch[1]!);
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const messages = orchestrator.bus.getTopicHistory(topic, limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ topic, count: messages.length, messages }));
      return;
    }

    // /api/bus/agent/:id — messages from/to a specific agent
    const agentMatch = url.pathname.match(/^\/api\/bus\/agent\/(.+)$/);
    if (agentMatch && req.method === "GET") {
      const agentId = decodeURIComponent(agentMatch[1]!) as any;
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const messages = orchestrator.bus.getAgentHistory(agentId, limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agentId, count: messages.length, messages }));
      return;
    }

    // /api/bus/chain/:messageId — conversation chain for a message
    const chainMatch = url.pathname.match(/^\/api\/bus\/chain\/(.+)$/);
    if (chainMatch && req.method === "GET") {
      const messageId = decodeURIComponent(chainMatch[1]!);
      const chain = orchestrator.bus.getChain(messageId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messageId, count: chain.length, chain }));
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
