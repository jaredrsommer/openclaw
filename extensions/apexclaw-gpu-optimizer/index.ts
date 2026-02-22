import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { createApexClawTool } from "./src/apexclaw-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createApexClawTool(api) as unknown as AnyAgentTool, { optional: true });
}
