/**
 * ApexClaw GPU-optimized trading tool for OpenClaw.
 *
 * Exposes the tiered model router and trading agent system as an
 * OpenClaw tool that can be invoked from the agent/chat interface.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { routeTask, estimateMonthlyCost, type RouterConfig, type TradingTaskType } from "./tiered-router.js";
import { ALL_AGENTS, getAgent } from "./trading-agents.js";
import { resolveGpuProfile, modelsForVram } from "./gpu-profiles.js";
import { FleetManager, DEFAULT_FLEET_CONFIG, type FleetConfig } from "./fleet-manager.js";

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

export function createApexClawTool(api: OpenClawPluginApi) {
  return {
    name: "apexclaw-trade",
    label: "ApexClaw Trading Router",
    description:
      "GPU-optimized trading agent router. Routes tasks across local GPU models (Ollama/vLLM on 8GB GPUs), free APIs (NVIDIA NIM, Grok), and paid APIs (Claude Max). Supports RBI pipeline, liquidation detection, sentiment analysis, and risk management.",
    parameters: Type.Object({
      action: Type.String({
        description:
          'Action: "route" (route a task), "agents" (list agents), "status" (fleet status), "gpu-info" (show GPU models), "cost-estimate" (monthly cost estimate)',
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
          const fleetConfig: FleetConfig = {
            nodes: pluginCfg.fleetNodes ?? DEFAULT_FLEET_CONFIG.nodes,
            healthCheckIntervalMs: 30000,
            healthCheckTimeoutMs: 5000,
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
              text: `Unknown action "${action}". Available: route, agents, status, gpu-info, cost-estimate`,
            }],
          };
      }
    },
  };
}
