import { config } from '../../config/index.js';
import { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from '../providers/provider.interface.js';
import { MockProvider } from '../providers/mock.provider.js';
import { OpenAIProvider } from '../providers/openai.provider.js';
import { GeminiProvider } from '../providers/gemini.provider.js';
import { AnthropicProvider } from '../providers/anthropic.provider.js';
import { ModelRunRepository } from '../../database/repositories/modelRun.repository.js';
import { logger } from '../../shared/logger.js';
import { ROUTER_CONFIGS, ModelType } from './config.js';
import { withRetryAndTimeout } from '../../shared/retry.js';

let testProviderOverride: LLMProvider | null = null;

/**
 * Instantiates the appropriate LLM provider based on config mapping.
 */
export function getProviderInstance(providerName: string, modelName: string): LLMProvider {
  if (testProviderOverride) return testProviderOverride;

  if (config.NODE_ENV === 'test') {
    return new MockProvider();
  }

  switch (providerName) {
    case 'openai':
      return new OpenAIProvider(config.OPENAI_API_KEY || '', modelName);
    case 'gemini':
      return new GeminiProvider(config.GOOGLE_AI_API_KEY || '', modelName);
    case 'anthropic':
      return new AnthropicProvider(config.ANTHROPIC_API_KEY || '', modelName);
    default:
      return new MockProvider();
  }
}

/**
 * Sets a mock provider override for test environments.
 */
export function setTestProvider(provider: LLMProvider | null) {
  testProviderOverride = provider;
}

export interface GatewayOptions {
  conversationId?: string;
  agentRunId?: string;
  modelType?: ModelType;
}

/**
 * GIA LLM Gateway centralizing model routing, timeout retries, and database run logging.
 */
export class LLMGateway {
  static async generate(request: LLMRequest, options: GatewayOptions = {}): Promise<LLMResponse> {
    const modelType = options.modelType ?? 'general';
    const modelConfig = ROUTER_CONFIGS[modelType];
    const provider = getProviderInstance(modelConfig.provider, modelConfig.model);
    const start = Date.now();

    logger.info({
      msg: `🤖 [LLM GATEWAY] Requesting LLM completion`,
      slot: modelType,
      targetProvider: modelConfig.provider,
      targetModel: modelConfig.model,
    });

    try {
      // Execute the call using standard retry configuration (3 attempts, fast delay in testing)
      const response = await withRetryAndTimeout(
        async (signal) => provider.generate(request, signal),
        { retries: 3, delay: config.NODE_ENV === 'test' ? 10 : 1000 }
      );
      const latency = Date.now() - start;

      logger.info({
        msg: `✅ [LLM GATEWAY] LLM execution succeeded`,
        provider: response.provider,
        model: response.model,
        latencyMs: latency,
      });

      // Rough token estimation (4 characters per token average)
      const promptText = (request.systemPrompt || '') + request.messages.map((m) => m.content).join(' ');
      const promptTokens = Math.ceil(promptText.length / 4);
      const completionTokens = Math.ceil(response.content.length / 4);

      // Async persist observability metrics
      ModelRunRepository.logRun({
        conversationId: options.conversationId || null,
        agentRunId: options.agentRunId || null,
        modelName: response.model,
        provider: response.provider,
        promptTokens,
        completionTokens,
        latencyMs: latency,
      }).catch((err) => logger.error({ msg: 'Failed to save model run metrics log', err: err.message }));

      return response;
    } catch (err: any) {
      const latency = Date.now() - start;

      // Save failure entry
      ModelRunRepository.logRun({
        conversationId: options.conversationId || null,
        agentRunId: options.agentRunId || null,
        modelName: modelConfig.model,
        provider: modelConfig.provider,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: latency,
        errors: err.message,
      }).catch((logErr) => logger.error({ msg: 'Failed to log failed model run metrics', err: logErr.message }));

      const errMsg = (err?.message || '').toLowerCase();
      const isQuotaOrRateLimit =
        errMsg.includes('429') ||
        errMsg.includes('quota') ||
        errMsg.includes('resource_exhausted') ||
        errMsg.includes('rate limit') ||
        errMsg.includes('rate_limit');

      if (isQuotaOrRateLimit && !testProviderOverride) {
        logger.warn({ msg: `Primary LLM provider '${modelConfig.provider}' hit rate limit (${err.message}). Attempting fallback provider...` });
        try {
          const fallbackProvider = new MockProvider();
          const fallbackRes = await fallbackProvider.generate(request);
          logger.info({ msg: `Successfully recovered using fallback provider 'mock'` });
          return fallbackRes;
        } catch {
          // ignore
        }
      }

      throw err;
    }
  }

  static async *stream(request: LLMRequest, options: GatewayOptions = {}): AsyncIterable<LLMChunk> {
    const modelType = options.modelType ?? 'general';
    const modelConfig = ROUTER_CONFIGS[modelType];
    const provider = getProviderInstance(modelConfig.provider, modelConfig.model);
    const start = Date.now();
    let fullText = '';

    try {
      const stream = provider.stream(request);
      for await (const chunk of stream) {
        fullText += chunk.content;
        yield chunk;
      }

      const latency = Date.now() - start;
      const promptText = (request.systemPrompt || '') + request.messages.map((m) => m.content).join(' ');
      const promptTokens = Math.ceil(promptText.length / 4);
      const completionTokens = Math.ceil(fullText.length / 4);

      ModelRunRepository.logRun({
        conversationId: options.conversationId || null,
        agentRunId: options.agentRunId || null,
        modelName: modelConfig.model,
        provider: modelConfig.provider,
        promptTokens,
        completionTokens,
        latencyMs: latency,
      }).catch((err) => logger.error({ msg: 'Failed to save streamed model run metrics log', err: err.message }));
    } catch (err: any) {
      const latency = Date.now() - start;

      ModelRunRepository.logRun({
        conversationId: options.conversationId || null,
        agentRunId: options.agentRunId || null,
        modelName: modelConfig.model,
        provider: modelConfig.provider,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: latency,
        errors: err.message,
      }).catch((logErr) => logger.error({ msg: 'Failed to log failed streamed model run metrics', err: logErr.message }));

      throw err;
    }
  }
}
export function getLLMProvider(): LLMProvider {
  return getProviderInstance('mock', 'mock-model');
}
