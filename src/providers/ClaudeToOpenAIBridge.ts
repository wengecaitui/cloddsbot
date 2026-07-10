/**
 * Claude ↔ OpenAI 智能桥接层 (ClaudeToOpenAIBridge)
 *
 * 负责双向转换:
 *  - Claude tool_use → OpenAI tools (请求端)
 *  - OpenAI tool_calls → Claude tool_use (响应端)
 *  - Claude tool_result → OpenAI role: tool (上下文历史)
 */

import { OpenAIProvider, AnthropicProvider } from './index';

// =============================================================================
// LOCAL ANTHROPIC-COMPATIBLE TYPE ALIASES
// =============================================================================
// This bridge operates on message shapes that match Anthropic SDK types.
// We define minimal structural type aliases here to avoid coupling to a
// specific @anthropic-ai/sdk version's namespace export layout. The shapes
// below are wire-compatible with Anthropic MessageParam / ContentBlock.
export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}
export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}
export interface AnthropicTextBlock extends AnthropicContentBlock {
  type: 'text';
  text: string;
}
export interface AnthropicToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

// =============================================================================
// RE-EXPORT AS Anthropic NAMESPACE
// =============================================================================
// Maintain backward compatibility: callers using `Anthropic.MessageParam[]`
// continue to work via this local namespace.
export namespace Anthropic {
  export type MessageParam = AnthropicMessageParam;
  export type ContentBlock = AnthropicContentBlock;
  export type TextBlock = AnthropicTextBlock;
  export type ToolResultBlockParam = AnthropicToolResultBlockParam;
}

// =============================================================================
// TYPE GUARDS & CONVERSION HELPERS
// =============================================================================

/** Anthropic tool definition (claude format) */
export interface ClaudeToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** OpenAI function tool definition */
export interface OpenAIFunctionDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Convert Claude tool schema → OpenAI function schema */
export function claudeToolToOpenAI(tool: ClaudeToolDef): OpenAIFunctionDef {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Record<string, unknown>,
    },
  };
}

/** Convert array of Claude tools → OpenAI tools array */
export function claudeToolsToOpenAI(tools: ClaudeToolDef[]): OpenAIFunctionDef[] {
  return tools.map(claudeToolToOpenAI);
}

// =============================================================================
// MESSAGE HISTORY CONVERSION (Claude → OpenAI)
// =============================================================================

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * Convert Claude message array to OpenAI format.
 * Claude tool_result blocks become OpenAI 'tool' role messages.
 */
export function claudeMessagesToOpenAI(
  claudeMessages: Anthropic.MessageParam[]
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of claudeMessages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Handle assistant messages with content blocks (tool_use)
      const textContent = (msg.content as Anthropic.ContentBlock[])
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('\n');

      if (textContent) {
        result.push({ role: 'assistant', content: textContent });
      }

      // Add tool_use calls as empty assistant messages (they'll be replaced by tool results)
      const toolUses = (msg.content as Anthropic.ContentBlock[]).filter(b => b.type === 'tool_use');
      for (const tu of toolUses) {
        result.push({
          role: 'assistant',
          content: `[tool_use:${tu.name}]`,
        });
      }
    } else if (msg.role === 'user' && typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant' && typeof msg.content === 'string') {
      result.push({ role: 'assistant', content: msg.content });
    }
  }

  return result;
}

/**
 * Convert OpenAI tool_calls array back to Claude content blocks
 * for injection into the message history
 */
export function openAIToolCallsToClaudeContent(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>
): Anthropic.ContentBlock[] {
  return toolCalls.map(tc => ({
    type: 'tool_use' as const,
    id: tc.id,
    name: tc.function.name,
    input: (() => {
      try {
        return JSON.parse(tc.function.arguments);
      } catch {
        return { raw: tc.function.arguments };
      }
    })(),
  }));
}

/**
 * Convert OpenAI tool result message back to Claude tool_result block
 */
export function openAIToolResultToClaude(
  toolCallId: string,
  content: string
): Anthropic.ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content,
  };
}

// =============================================================================
// MAIN BRIDGE CLASS
// =============================================================================

export class ClaudeToOpenAIBridge {
  private openaiProvider: OpenAIProvider;

  constructor(openaiProvider: OpenAIProvider) {
    this.openaiProvider = openaiProvider;
  }

  /**
   * Complete with OpenAI provider using Claude tool definitions
   */
  async complete(
    messages: OpenAIMessage[],
    tools: ClaudeToolDef[],
    options: { model?: string; maxTokens?: number; temperature?: number } = {}
  ): Promise<{
    content: string;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    finish_reason: string;
  }> {
    const openaiTools = claudeToolsToOpenAI(tools);

    const result = await this.openaiProvider.complete(
      messages as any,
      {
        model: options.model,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        tools: openaiTools,
      }
    );

    // Parse tool_calls from OpenAI response (stored in metadata)
    const toolCalls = (result as any as { _tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> })._tool_calls as Array<{
      id: string;
      function: { name: string; arguments: string };
    }> | undefined;

    return {
      content: result.content,
      tool_calls: toolCalls,
      finish_reason: result.finishReason,
    };
  }
}

// =============================================================================
// PRECISION GUARD: BigInt/JSON serialization
// =============================================================================

/**
 * Safely stringify objects containing BigInt for JSON transport.
 * Replaces BigInt with string to avoid "Do not know how to serialize a BigInt" errors.
 */
export function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

/**
 * Re-parse a JSON string that may contain BigInt-formatted numbers back to BigInt objects.
 * This is used for @noble/* output verification in Phase 4.
 */
export function parseWithBigInt(jsonStr: string): unknown {
  return JSON.parse(jsonStr, (key, value) => {
    if (typeof value === 'string' && /^-?\d+$/.test(value) && Number(value) > Number.MAX_SAFE_INTEGER) {
      try {
        return BigInt(value);
      } catch {
        return value;
      }
    }
    return value;
  });
}
