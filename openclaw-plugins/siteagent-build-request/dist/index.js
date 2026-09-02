import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin"

import { createSiteAgentBuildRequestTool } from "./tool.js"

export default defineToolPlugin({
  id: "siteagent-build-request",
  name: "Sajtagent Build Request",
  description: "Adds the typed Site-owned build-request handoff signal.",
  tools: (tool) => [createSiteAgentBuildRequestTool(tool)],
})
