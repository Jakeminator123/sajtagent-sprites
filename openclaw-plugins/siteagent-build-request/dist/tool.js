import { Type } from "typebox"

export const SITEAGENT_BUILD_REQUEST_TOOL_NAME = "siteagent_build_request"

export function createSiteAgentBuildRequestTool(tool) {
  return tool({
    name: SITEAGENT_BUILD_REQUEST_TOOL_NAME,
    label: "Request a Site build",
    description:
      "Signal a Site-owned build handoff only when the user explicitly requests a site mutation. This tool does not build, preview, persist, or confirm success.",
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object(
      {
        handoff: Type.Literal("requested"),
        authoritative: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
    optional: true,
    execute(_params, _config, context) {
      context.signal?.throwIfAborted()
      return { handoff: "requested", authoritative: false }
    },
  })
}
