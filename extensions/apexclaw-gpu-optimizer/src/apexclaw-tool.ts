/**
 * ApexClaw GPU-optimized trading tool for OpenClaw.
 *
 * Exposes the tiered model router, 4-node fleet orchestrator, and trading
 * agent system as an OpenClaw tool invokable from the agent/chat interface.
 * Also starts the dashboard server on the Queen node.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { routeTask, estimateMonthlyCost, type RouterConfig, type TradingTaskType } from "./tiered-router.js";
import { ALL_AGENTS, getAgent } from "./trading-agents.js";
import { resolveGpuProfile, modelsForVram } from "./gpu-profiles.js";
import { FleetManager, DEFAULT_FLEET_CONFIG, type FleetConfig } from "./fleet-manager.js";
import { QueenOrchestrator } from "./queen-orchestrator.js";
import { startDashboardServer } from "./dashboard-server.js";
import { RemoteFleetClient, discoverQueenNode } from "./remote-client.js";

type PluginCfg = {
  gpuVramMb?: number;
  localOllamaUrl?: string;
  localVllmUrl?: string;
  nvidiaApiKey?: string;
  grokApiKey?: string;
  tier?: string;
  maxLocalConcurrency?: number;
  tradingMode?: boolean;
  fleetNodes?: FleetConfig["nodes"];
  dashboardPort?: number;
  /** Set to the Queen node IP when running from your laptop (no local GPU). */
  remoteQueenHost?: string;
  /** "local" = this machine runs agents. "remote" = this is a laptop/control node. "auto" = detect. */
  mode?: "local" | "remote" | "auto";
};

function buildRouterConfig(cfg: PluginCfg): RouterConfig {
  return {
    gpuVramMb: cfg.gpuVramMb ?? 8192,
    localOllamaUrl: cfg.localOllamaUrl ?? "http://127.0.0.1:11434",
    localVllmUrl: cfg.localVllmUrl ?? "http://127.0.0.1:8000/v1",
    hasNvidiaApi: Boolean(cfg.nvidiaApiKey || process.env.NVIDIA_API_KEY),
    hasGrokApi: Boolean(cfg.grokApiKey || process.env.XAI_API_KEY || process.env.GROK_API_KEY),
    hasClaudeApi: Boolean(process.env.ANTHROPIC_API_KEY),
    forceTier: cfg.tier === "local" || cfg.tier === "free-api" || cfg.tier === "paid-api"
      ? cfg.tier
      : undefined,
    maxLocalConcurrency: cfg.maxLocalConcurrency ?? 1,
    currentLocalLoad: 0,
    customQwenAvailable: Boolean(cfg.localVllmUrl),
  };
}

// Singleton state for the running orchestrator
let activeFleet: FleetManager | null = null;
let activeOrchestrator: QueenOrchestrator | null = null;
let activeDashboard: ReturnType<typeof startDashboardServer> | null = null;

export function createApexClawTool(api: OpenClawPluginApi) {
  return {
    name: "apexclaw-trade",
    label: "ApexClaw Trading Router",
    description:
      "GPU-optimized trading agent router for 4x GTX 1070 Ti fleet. Routes tasks across local GPU models (Ollama/vLLM), free APIs (NVIDIA NIM, Grok), and paid APIs (Claude Max). Includes dashboard, RBI pipeline, liquidation detection, sentiment analysis, and risk management.",
    parameters: Type.Object({
      action: Type.String({
        description:
          'Action: "route" (route a task), "agents" (list agents), "status" (fleet status), "gpu-info" (show GPU models), "cost-estimate" (monthly cost estimate), "dashboard" (start dashboard), "start" (start orchestrator), "stop" (stop orchestrator)',
      }),
      taskType: Type.Optional(
        Type.String({
          description:
            "Trading task type for routing: signal-classification, sentiment-analysis, market-summary, risk-assessment, order-generation, liquidation-detection, rbi-research, rbi-backtest, rbi-implement, stream-observation, anomaly-detection, polymarket-analysis, general",
        }),
      ),
      agentId: Type.Optional(
        Type.String({ description: "Agent template ID for agent details." }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "Prompt to send to the routed model." }),
      ),
      forceTier: Type.Optional(
        Type.String({ description: 'Override tier: "local", "free-api", or "paid-api".' }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const action = String(params.action ?? "status");
      const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;
      const routerConfig = buildRouterConfig(pluginCfg);

      // --- Remote mode: proxy everything to the Queen node ---
      const isRemote = pluginCfg.mode === "remote" || (pluginCfg.mode !== "local" && pluginCfg.remoteQueenHost);
      if (isRemote) {
        return handleRemoteAction(action, params, pluginCfg);
      }

      switch (action) {
        case "route": {
          const taskType = String(params.taskType ?? "general") as TradingTaskType;
          const forceTier = params.forceTier
            ? (String(params.forceTier) as "local" | "free-api" | "paid-api")
            : undefined;
          const decision = routeTask(taskType, routerConfig, { forceTier });

          const result = {
            routing: decision,
            agent: getAgent(
              ALL_AGENTS.find((a) => a.taskType === taskType)?.id ?? "",
            ),
          };

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "agents": {
          const agentId = params.agentId ? String(params.agentId) : undefined;
          if (agentId) {
            const agent = getAgent(agentId);
            if (!agent) {
              return {
                content: [{ type: "text", text: `Agent "${agentId}" not found. Available: ${ALL_AGENTS.map((a) => a.id).join(", ")}` }],
              };
            }
            const route = routeTask(agent.taskType, routerConfig);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ agent, routing: route }, null, 2),
              }],
            };
          }

          const agentList = ALL_AGENTS.map((a) => {
            const route = routeTask(a.taskType, routerConfig);
            return {
              id: a.id,
              name: a.name,
              mode: a.mode,
              taskType: a.taskType,
              routedTo: `${route.tier} / ${route.provider} / ${route.model}`,
              cost: route.estimatedCostUsd === 0 ? "FREE" : `$${route.estimatedCostUsd}`,
            };
          });

          return {
            content: [{ type: "text", text: JSON.stringify(agentList, null, 2) }],
          };
        }

        case "status": {
          if (activeOrchestrator) {
            const snapshot = activeOrchestrator.getSnapshot();
            return {
              content: [{
                type: "text",
                text: JSON.stringify(snapshot, null, 2),
              }],
            };
          }

          // No orchestrator running — do a quick fleet probe
          const fleetConfig: FleetConfig = {
            nodes: pluginCfg.fleetNodes ?? DEFAULT_FLEET_CONFIG.nodes,
            healthCheckIntervalMs: 15000,
            healthCheckTimeoutMs: 5000,
            dashboardPort: pluginCfg.dashboardPort ?? 3939,
          };
          const fleet = new FleetManager(fleetConfig);
          await fleet.checkAllHealth();
          const status = fleet.getStatus();
          fleet.stop();

          const gpuProfile = resolveGpuProfile(routerConfig.gpuVramMb);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                orchestratorRunning: false,
                gpuProfile: {
                  name: gpuProfile.name,
                  vramMb: gpuProfile.vramMb,
                  maxConcurrentModels: gpuProfile.maxConcurrentModels,
                  availableModels: gpuProfile.models.length,
                },
                fleet: status,
                providers: {
                  nvidia: routerConfig.hasNvidiaApi ? "configured" : "not configured",
                  grok: routerConfig.hasGrokApi ? "configured" : "not configured",
                  claude: routerConfig.hasClaudeApi ? "configured" : "not configured",
                  ollama: routerConfig.localOllamaUrl,
                  vllm: routerConfig.localVllmUrl,
                },
              }, null, 2),
            }],
          };
        }

        case "start": {
          if (activeOrchestrator) {
            return { content: [{ type: "text", text: "Orchestrator already running." }] };
          }

          const fc: FleetConfig = {
            nodes: pluginCfg.fleetNodes ?? DEFAULT_FLEET_CONFIG.nodes,
            healthCheckIntervalMs: 15000,
            healthCheckTimeoutMs: 5000,
            dashboardPort: pluginCfg.dashboardPort ?? 3939,
          };
          activeFleet = new FleetManager(fc);
          // Find the MoE node's Ollama URL for local embeddings
          const moeNode = fc.nodes.find((n) => n.hasCustomQwen) ?? fc.nodes[0];
          activeOrchestrator = new QueenOrchestrator(
            activeFleet,
            // Local embeddings config (nomic-embed-text on CPU via Ollama)
            moeNode ? {
              ollamaUrl: `http://${moeNode.host}:${moeNode.ollamaPort}`,
              model: "nomic-embed-text:v1.5",
              maxCacheEntries: 500_000,
            } : undefined,
            // API optimizer config
            {
              cacheTtlMs: 60_000,
              endpoints: moeNode ? {
                ollama: `http://${moeNode.host}:${moeNode.ollamaPort}`,
                vllm: `http://${moeNode.host}:${moeNode.vllmPort}/v1`,
              } : undefined,
            },
          );
          await activeOrchestrator.start();

          const dashPort = pluginCfg.dashboardPort ?? 3939;
          activeDashboard = startDashboardServer(activeOrchestrator, activeFleet, {
            port: dashPort,
            host: "0.0.0.0",
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "started",
                dashboard: `http://localhost:${dashPort}`,
                fleet: activeFleet.getStatus(),
              }, null, 2),
            }],
          };
        }

        case "stop": {
          if (!activeOrchestrator) {
            return { content: [{ type: "text", text: "Orchestrator not running." }] };
          }
          activeOrchestrator.stop();
          activeDashboard?.close();
          activeOrchestrator = null;
          activeFleet = null;
          activeDashboard = null;
          return { content: [{ type: "text", text: "Orchestrator and dashboard stopped." }] };
        }

        case "dashboard": {
          if (!activeOrchestrator || !activeFleet) {
            return { content: [{ type: "text", text: "Start the orchestrator first with action: start" }] };
          }
          const dp = pluginCfg.dashboardPort ?? 3939;
          return {
            content: [{
              type: "text",
              text: `Dashboard running at http://localhost:${dp}\n\nOpen in your browser to see:\n- Fleet status (scales 1-4 nodes)\n- Agent status and routing decisions\n- RBI pipeline progress\n- Embedding cache stats (local nomic-embed-text)\n- API optimizer stats (dedup, cache hit rate, queuing)\n- Signal dedup rate\n- Real-time event stream\n- Cost tracking across tiers`,
            }],
          };
        }

        case "gpu-info": {
          const vramMb = routerConfig.gpuVramMb;
          const profile = resolveGpuProfile(vramMb);
          const fittingModels = modelsForVram(vramMb);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                gpu: profile.name,
                vramMb: profile.vramMb,
                models: fittingModels.map((m) => ({
                  tag: m.ollamaTag,
                  name: m.name,
                  vramMb: m.vramMb,
                  role: m.role,
                  speed: m.speedTier === 1 ? "fast" : m.speedTier === 2 ? "medium" : "slow",
                  toolUse: m.toolUse,
                  contextWindow: m.contextWindow,
                })),
                ollamaSetupCommands: fittingModels.map(
                  (m) => `ollama pull ${m.ollamaTag}`,
                ),
              }, null, 2),
            }],
          };
        }

        case "cost-estimate": {
          // Example daily task distribution for a moderate trading setup
          const dailyTasks: Record<TradingTaskType, number> = {
            "signal-classification": 500,
            "sentiment-analysis": 96,
            "market-summary": 24,
            "risk-assessment": 288,
            "order-generation": 100,
            "liquidation-detection": 1000,
            "rbi-research": 5,
            "rbi-backtest": 10,
            "rbi-implement": 2,
            "stream-observation": 5000,
            "anomaly-detection": 6,
            "polymarket-analysis": 48,
            general: 50,
          };

          const estimate = estimateMonthlyCost(dailyTasks, routerConfig);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                dailyTasks,
                monthlyEstimate: estimate,
                note: "Local and free-api tiers cost $0. Only paid-api (Claude/Grok Pro) incurs charges.",
              }, null, 2),
            }],
          };
        }

        default:
          return {
            content: [{
              type: "text",
              text: `Unknown action "${action}". Available: start, stop, status, dashboard, route, agents, gpu-info, cost-estimate`,
            }],
          };
      }
    },
  };
}

/**
 * Handle actions in remote mode (running from laptop, proxying to Queen node).
 */
async function handleRemoteAction(
  action: string,
  params: Record<string, unknown>,
  cfg: PluginCfg,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const dashPort = cfg.dashboardPort ?? 3939;
  let queenHost = cfg.remoteQueenHost;

  // Auto-discover if no host configured
  if (!queenHost) {
    queenHost = await discoverQueenNode(dashPort);
    if (!queenHost) {
      return {
        content: [{
          type: "text",
          text: [
            "Could not find the Queen node on the network.",
            "",
            "Either:",
            '  1. Set "remoteQueenHost" in the plugin config to the Queen machine\'s IP',
            "  2. Make sure the orchestrator is running on the Queen node (run action:start there first)",
            "",
            "Example laptop config in openclaw.json:",
            JSON.stringify({
              plugins: {
                "apexclaw-gpu-optimizer": {
                  mode: "remote",
                  remoteQueenHost: "192.168.1.102",
                  dashboardPort: 3939,
                },
              },
            }, null, 2),
          ].join("\n"),
        }],
      };
    }
  }

  const client = new RemoteFleetClient({ queenHost, dashboardPort: dashPort, timeoutMs: 10000 });
  const dashUrl = client.getDashboardUrl();

  switch (action) {
    case "status": {
      try {
        const snapshot = await client.getSnapshot();
        return {
          content: [{
            type: "text",
            text: `Connected to Queen at ${dashUrl}\n\n${JSON.stringify(snapshot, null, 2)}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Failed to reach Queen at ${dashUrl}: ${err}\n\nMake sure the orchestrator is running on the Queen node.`,
          }],
        };
      }
    }

    case "dashboard": {
      const reachable = await client.ping();
      return {
        content: [{
          type: "text",
          text: reachable
            ? `Dashboard: ${dashUrl}\n\nOpen this URL in your browser to monitor and control the fleet.`
            : `Queen node at ${dashUrl} is not responding.\nMake sure the orchestrator is running on that machine.`,
        }],
      };
    }

    case "agents": {
      try {
        const agents = await client.getAgents();
        return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err}` }] };
      }
    }

    case "start": {
      return {
        content: [{
          type: "text",
          text: [
            "You're in remote mode (laptop). The orchestrator must be started on the Queen node itself.",
            "",
            "SSH into your Queen machine and run:",
            `  ssh ${queenHost}`,
            "  openclaw  # then use apexclaw-trade action:start",
            "",
            "Or start it directly:",
            `  ssh ${queenHost} 'cd /path/to/openclaw && nohup node start-apexclaw.js &'`,
            "",
            `Once running, control it from here or open ${dashUrl} in your browser.`,
          ].join("\n"),
        }],
      };
    }

    case "stop":
    case "pause": {
      try {
        const result = await client.sendCommand(action === "stop" ? "pause" : action);
        return { content: [{ type: "text", text: `Sent ${action} to Queen at ${dashUrl}\n${JSON.stringify(result)}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to send ${action}: ${err}` }] };
      }
    }

    case "emergency-stop": {
      try {
        const result = await client.emergencyStop(String(params.prompt ?? "Emergency stop from laptop"));
        return { content: [{ type: "text", text: `EMERGENCY STOP sent to ${dashUrl}\n${JSON.stringify(result)}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to send emergency stop: ${err}` }] };
      }
    }

    case "rbi-start": {
      try {
        const result = await client.startRbi(String(params.prompt ?? "Manual research trigger"));
        return { content: [{ type: "text", text: `RBI pipeline started on Queen\n${JSON.stringify(result)}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err}` }] };
      }
    }

    default:
      return {
        content: [{
          type: "text",
          text: [
            `Remote mode — action "${action}" not proxied.`,
            "",
            "Available remote actions: status, dashboard, agents, pause, stop, emergency-stop, rbi-start",
            `Or open ${dashUrl} in your browser for the full dashboard.`,
          ].join("\n"),
        }],
      };
  }
}
