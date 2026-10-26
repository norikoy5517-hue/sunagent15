import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AbstractTool } from "./AbstractTool.js";
import { createSuccessResponse, createErrorResponse } from "../common/response.js";
import type { OpenAIRealtimeClient } from "../clients/openai-realtime-client.js";

const realtimeToolSchema = z.object({
  name: z.string().describe("Tool function name"),
  description: z.string().describe("Tool function description"),
  parameters: z.record(z.string(), z.unknown()).describe("JSON Schema for tool parameters"),
});

export default class StartRealtimeSessionTool extends AbstractTool {
  private readonly client: OpenAIRealtimeClient;

  constructor(client: OpenAIRealtimeClient) {
    super();
    this.client = client;
  }

  register(server: McpServer): void {
    server.tool(
      "voice_start_realtime_session",
      "Start a new OpenAI Realtime API session for voice AI interactions. Returns a session ID that can be used with other voice tools.",
      {
        systemPrompt: z.string().optional().describe("System prompt/instructions for the AI agent"),
        tools: z.array(realtimeToolSchema).optional().describe("Custom tools available to the AI agent during the session"),
        voice: z.enum(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]).optional().describe("Voice to use. Default: alloy"),
        language: z.string().optional().describe("Language code (e.g. en, ja). Default: en"),
      },
      async ({ systemPrompt, tools, voice, language }) => {
        try {
          const session = await this.client.createSession({
            systemPrompt,
            tools,
            voice: voice || language
              ? {
                  voice: voice ?? "alloy",
                  language: language ?? "en",
                  speed: 1.0,
                  pitch: 1.0,
                }
              : undefined,
          });

          return createSuccessResponse({
            sessionId: session.sessionId,
            status: session.status,
            createdAt: session.createdAt,
            voice: session.config.voice.voice,
            model: this.client.getModel(),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return createErrorResponse(`Failed to start realtime session: ${message}`);
        }
      }
    );
  }
}
