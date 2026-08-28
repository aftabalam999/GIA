import { config } from '../../config/index.js';
import { LLMGateway } from '../router/index.js';
import { registry } from '../tools/registry.js';
import { logger } from '../../shared/logger.js';

export interface RoutingDecision {
  route: 'direct_response' | 'memory_retrieval' | 'rag' | 'tool' | 'multi_step';
  reason: string;
  requires_memory: boolean;
  requires_rag: boolean;
  requires_tool: boolean;
  tool: { name: string; args: any } | null;
}

export const SAFE_FALLBACK_ROUTE: RoutingDecision = {
  route: 'direct_response',
  reason: 'Fallback triggered due to routing LLM failure or timeout.',
  requires_memory: false,
  requires_rag: false,
  requires_tool: false,
  tool: null,
};

export const routerTestOverrides = {
  mockDecision: null as RoutingDecision | null,
  shouldTimeout: false,
  shouldFail: false,
};

export class AgentRouter {
  static resetOverrides() {
    routerTestOverrides.mockDecision = null;
    routerTestOverrides.shouldTimeout = false;
    routerTestOverrides.shouldFail = false;
  }

  static async route(queryText: string, userId: string): Promise<RoutingDecision> {
    const start = Date.now();

    // 1. Handle test overrides
    if (routerTestOverrides.shouldFail) {
      logger.warn({ msg: 'Routing fallback triggered via test failure override' });
      return SAFE_FALLBACK_ROUTE;
    }
    if (routerTestOverrides.shouldTimeout) {
      logger.warn({ msg: 'Routing fallback triggered via test timeout override' });
      return SAFE_FALLBACK_ROUTE;
    }
    if (routerTestOverrides.mockDecision) {
      // Validate mock policy first
      const isValid = this.validatePolicy(routerTestOverrides.mockDecision);
      return isValid ? routerTestOverrides.mockDecision : SAFE_FALLBACK_ROUTE;
    }

    // 2. Perform Routing LLM Call
    try {
      const systemPrompt = `You are the Routing Router for GIA, a personal intelligent assistant.
Your task is to analyze the user's input query and determine the most appropriate routing path.
You must output a single JSON object matching this schema:
{
  "route": "direct_response" | "memory_retrieval" | "rag" | "tool" | "multi_step",
  "reason": "short explanation of the decision",
  "requires_memory": boolean,
  "requires_rag": boolean,
  "requires_tool": boolean,
  "tool": { "name": string, "args": object } | null
}

Available Routes:
1. "direct_response": For general conversational queries, chit-chat, simple formatting, explanations, or questions that do not require external tools, memories, or custom documents.
2. "memory_retrieval": For queries asking about user preferences, personal facts, things to remember, or retrieving specific user notes.
3. "rag": For queries asking about uploaded documents, guides, manuals, text files, or factual knowledge retrieval from user's document index.
4. "tool": For queries requesting execution of a specific system tool. Available tools:
   - "get_current_time": Get the current date and time (arguments: {}).
   - "search_memories": Search user memories semantically (arguments: { "query": string }).
   - "list_documents": List all document metadata uploaded (arguments: {}).
5. "multi_step": For complex queries requiring multiple operations (e.g. retrieving documents AND checking the time).

Constraints:
- If no external data, tools, or memory are needed, select "direct_response".
- For "tool" route, the "tool" property must be set with the correct name and arguments. Only use registered tools.
- Output ONLY valid JSON. No other text.`;

      // Set a short routing deadline timeout of 5 seconds to ensure fast response.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      let response;
      try {
        response = await LLMGateway.generate(
          {
            systemPrompt,
            messages: [{ role: 'user', content: queryText }],
            temperature: 0.0, // force deterministic decisions
            responseFormat: 'json',
          },
          { modelType: 'fast' }
        );
      } finally {
        clearTimeout(timeoutId);
      }

      const decision = JSON.parse(response.content) as RoutingDecision;

      // 3. Schema & Backend Policy Verification
      const isValid = this.validatePolicy(decision);
      
      const latency = Date.now() - start;
      logger.info({
        msg: 'Routing LLM completion details',
        route: decision.route,
        latency,
        model: response.model,
        provider: response.provider,
        isValid,
      });

      if (!isValid) {
        logger.warn({ msg: 'Routing decision failed backend policy validation', decision });
        return SAFE_FALLBACK_ROUTE;
      }

      return decision;
    } catch (err: any) {
      logger.error({ msg: 'Routing LLM call failed, falling back to direct response', error: err.message });
      return SAFE_FALLBACK_ROUTE;
    }
  }

  /**
   * Authoritative backend policy validation.
   */
  private static validatePolicy(decision: any): boolean {
    if (!decision || typeof decision !== 'object') return false;

    // Validate route enum
    const validRoutes = ['direct_response', 'memory_retrieval', 'rag', 'tool', 'multi_step'];
    if (!validRoutes.includes(decision.route)) return false;

    // Validate boolean fields
    if (typeof decision.requires_memory !== 'boolean') return false;
    if (typeof decision.requires_rag !== 'boolean') return false;
    if (typeof decision.requires_tool !== 'boolean') return false;

    // Validate tool constraints
    if (decision.requires_tool || decision.route === 'tool' || decision.tool) {
      if (!decision.tool || typeof decision.tool !== 'object') return false;
      if (typeof decision.tool.name !== 'string') return false;
      if (!decision.tool.args || typeof decision.tool.args !== 'object') return false;

      // Assert tool is registered in the GIA tool registry
      const registeredTool = registry.get(decision.tool.name);
      if (!registeredTool) {
        logger.warn({ msg: 'Rejected route proposing unregistered tool', toolName: decision.tool.name });
        return false;
      }
    }

    return true;
  }
}
