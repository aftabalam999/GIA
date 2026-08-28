import { config } from '../config/index.js';
import { checkConnection } from '../database/client.js';
import { redis } from './redis.js';
import { ROUTER_CONFIGS } from '../ai/router/config.js';
import { logger } from './logger.js';

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  dependencies: {
    database: 'healthy' | 'unhealthy';
    redis: 'healthy' | 'unhealthy';
    llm: 'healthy' | 'unhealthy' | 'unconfigured';
    embeddings: 'healthy' | 'unhealthy' | 'unconfigured';
  };
  latency: {
    database: number;
    redis: number;
    llm?: number;
    embeddings?: number;
  };
}

export const healthTestOverrides = {
  databaseHealthy: null as boolean | null,
  redisHealthy: null as boolean | null,
  llmHealthy: null as boolean | null,
  embeddingsHealthy: null as boolean | null,
  databaseLatency: null as number | null,
  redisLatency: null as number | null,
  llmLatency: null as number | null,
  embeddingsLatency: null as number | null,
};

const TIMEOUT_MS = 3000;

export class HealthService {
  /**
   * Reset overrides to clean state.
   */
  static resetOverrides() {
    healthTestOverrides.databaseHealthy = null;
    healthTestOverrides.redisHealthy = null;
    healthTestOverrides.llmHealthy = null;
    healthTestOverrides.embeddingsHealthy = null;
    healthTestOverrides.databaseLatency = null;
    healthTestOverrides.redisLatency = null;
    healthTestOverrides.llmLatency = null;
    healthTestOverrides.embeddingsLatency = null;
  }

  /**
   * Evaluates deep dependency health report.
   */
  static async checkDeepHealth(): Promise<HealthReport> {
    const report: HealthReport = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      dependencies: {
        database: 'unhealthy',
        redis: 'unhealthy',
        llm: 'unconfigured',
        embeddings: 'unconfigured',
      },
      latency: {
        database: 0,
        redis: 0,
      },
    };

    // 1. Probe Database
    const dbStart = Date.now();
    try {
      const isDbOk = healthTestOverrides.databaseHealthy !== null
        ? healthTestOverrides.databaseHealthy
        : await checkConnection();
      report.dependencies.database = isDbOk ? 'healthy' : 'unhealthy';
      report.latency.database = healthTestOverrides.databaseLatency ?? (Date.now() - dbStart);
    } catch (err: any) {
      report.dependencies.database = 'unhealthy';
      logger.error({ msg: 'Health probe database check error', err: err.message });
    }

    // 2. Probe Redis
    const redisStart = Date.now();
    try {
      let isRedisOk = false;
      if (healthTestOverrides.redisHealthy !== null) {
        isRedisOk = healthTestOverrides.redisHealthy;
      } else {
        const ping = await redis.ping();
        isRedisOk = ping === 'PONG';
      }
      report.dependencies.redis = isRedisOk ? 'healthy' : 'unhealthy';
      report.latency.redis = healthTestOverrides.redisLatency ?? (Date.now() - redisStart);
    } catch (err: any) {
      report.dependencies.redis = 'unhealthy';
      logger.error({ msg: 'Health probe Redis check error', err: err.message });
    }

    // 3. Probe LLM API
    const llmProvider = ROUTER_CONFIGS.general.provider;
    const llmStart = Date.now();
    if (healthTestOverrides.llmHealthy !== null) {
      report.dependencies.llm = healthTestOverrides.llmHealthy ? 'healthy' : 'unhealthy';
      report.latency.llm = healthTestOverrides.llmLatency ?? (Date.now() - llmStart);
    } else if (config.NODE_ENV === 'test') {
      report.dependencies.llm = 'healthy';
      report.latency.llm = 5;
    } else {
      try {
        const status = await this.probeLLMProvider(llmProvider);
        report.dependencies.llm = status;
        if (status !== 'unconfigured') {
          report.latency.llm = Date.now() - llmStart;
        }
      } catch (err: any) {
        report.dependencies.llm = 'unhealthy';
        logger.error({ msg: 'Health probe LLM API error', err: err.message });
      }
    }

    // 4. Probe Embeddings API
    const hasOpenAIKey = !!config.OPENAI_API_KEY;
    const embStart = Date.now();
    if (healthTestOverrides.embeddingsHealthy !== null) {
      report.dependencies.embeddings = healthTestOverrides.embeddingsHealthy ? 'healthy' : 'unhealthy';
      report.latency.embeddings = healthTestOverrides.embeddingsLatency ?? (Date.now() - embStart);
    } else if (config.NODE_ENV === 'test') {
      report.dependencies.embeddings = 'healthy';
      report.latency.embeddings = 5;
    } else if (!hasOpenAIKey) {
      report.dependencies.embeddings = 'unconfigured';
    } else {
      try {
        const status = await this.probeOpenAI(config.OPENAI_API_KEY || '');
        report.dependencies.embeddings = status;
        report.latency.embeddings = Date.now() - embStart;
      } catch (err: any) {
        report.dependencies.embeddings = 'unhealthy';
        logger.error({ msg: 'Health probe Embeddings API error', err: err.message });
      }
    }

    // 5. Classify Overall Status
    const isCoreHealthy = report.dependencies.database === 'healthy' && report.dependencies.redis === 'healthy';
    if (!isCoreHealthy) {
      report.status = 'unhealthy';
    } else {
      const isLlmHealthy = report.dependencies.llm === 'healthy' || report.dependencies.llm === 'unconfigured';
      const isEmbHealthy = report.dependencies.embeddings === 'healthy' || report.dependencies.embeddings === 'unconfigured';
      if (!isLlmHealthy || !isEmbHealthy) {
        report.status = 'degraded';
      } else {
        report.status = 'healthy';
      }
    }

    return report;
  }

  private static async probeLLMProvider(provider: string): Promise<'healthy' | 'unhealthy' | 'unconfigured'> {
    switch (provider) {
      case 'openai':
        if (!config.OPENAI_API_KEY) return 'unconfigured';
        return this.probeOpenAI(config.OPENAI_API_KEY);
      case 'gemini':
        if (!config.GOOGLE_AI_API_KEY) return 'unconfigured';
        return this.probeGemini(config.GOOGLE_AI_API_KEY);
      case 'anthropic':
        if (!config.ANTHROPIC_API_KEY) return 'unconfigured';
        return this.probeAnthropic(config.ANTHROPIC_API_KEY);
      default:
        return 'unconfigured';
    }
  }

  private static async probeOpenAI(apiKey: string): Promise<'healthy' | 'unhealthy'> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(id);
      return res.status === 200 ? 'healthy' : 'unhealthy';
    } catch {
      clearTimeout(id);
      return 'unhealthy';
    }
  }

  private static async probeGemini(apiKey: string): Promise<'healthy' | 'unhealthy'> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
        signal: controller.signal,
      });
      clearTimeout(id);
      return res.status === 200 ? 'healthy' : 'unhealthy';
    } catch {
      clearTimeout(id);
      return 'unhealthy';
    }
  }

  private static async probeAnthropic(apiKey: string): Promise<'healthy' | 'unhealthy'> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      clearTimeout(id);
      // Sending an empty request yields 400 Bad Request if authenticated and reachable,
      // whereas bad keys yield 401 Unauthorized, and timeout/network drops yield exceptions.
      return res.status === 400 ? 'healthy' : 'unhealthy';
    } catch {
      clearTimeout(id);
      return 'unhealthy';
    }
  }
}
