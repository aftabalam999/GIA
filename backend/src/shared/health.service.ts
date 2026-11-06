import { config } from '../config/index.js';
import { checkConnection } from '../database/client.js';
import { redis } from './redis.js';
import { logger } from './logger.js';

import { aiServiceClient } from '../ai/ml-client/ai-service.client.js';
import { DeepReadinessProbeResult } from '../ai/ml-client/ai-service.types.js';

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  dependencies: {
    database: 'healthy' | 'unhealthy';
    redis: 'healthy' | 'unhealthy';
    python_ai_service: 'healthy' | 'degraded' | 'unhealthy';
    llm: 'healthy' | 'unhealthy' | 'unconfigured';
    embeddings: 'healthy' | 'unhealthy' | 'unconfigured';
  };
  python_ai_service?: DeepReadinessProbeResult;
  latency: {
    database: number;
    redis: number;
    python_ai_service?: number;
    llm?: number;
    embeddings?: number;
  };
}

export const healthTestOverrides = {
  databaseHealthy: null as boolean | null,
  redisHealthy: null as boolean | null,
  pythonAiHealthy: null as boolean | null,
  pythonAiReady: null as boolean | null,
  llmHealthy: null as boolean | null,
  embeddingsHealthy: null as boolean | null,
  databaseLatency: null as number | null,
  redisLatency: null as number | null,
  pythonAiLatency: null as number | null,
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
    healthTestOverrides.pythonAiHealthy = null;
    healthTestOverrides.pythonAiReady = null;
    healthTestOverrides.llmHealthy = null;
    healthTestOverrides.embeddingsHealthy = null;
    healthTestOverrides.databaseLatency = null;
    healthTestOverrides.redisLatency = null;
    healthTestOverrides.pythonAiLatency = null;
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
        python_ai_service: 'unhealthy',
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

    // 3. Probe Python AI Service
    const pyStart = Date.now();
    try {
      if (healthTestOverrides.pythonAiHealthy !== null) {
        const isPyOk = healthTestOverrides.pythonAiHealthy;
        const isPyReady = healthTestOverrides.pythonAiReady ?? isPyOk;
        report.dependencies.python_ai_service = isPyOk ? (isPyReady ? 'healthy' : 'degraded') : 'unhealthy';
        report.python_ai_service = {
          reachable: isPyOk,
          healthy: isPyOk,
          ready: isPyReady,
          subsystems: { audio_processor: true, vad: true, stt: isPyReady, tts: isPyReady, embedding: true, reranker: true },
        };
        report.latency.python_ai_service = healthTestOverrides.pythonAiLatency ?? (Date.now() - pyStart);
      } else {
        const pyResult = await aiServiceClient.checkDeepReadiness({ timeoutMs: 3000 });
        report.python_ai_service = pyResult;
        if (!pyResult.reachable || !pyResult.healthy) {
          report.dependencies.python_ai_service = 'unhealthy';
        } else if (!pyResult.ready) {
          report.dependencies.python_ai_service = 'degraded';
        } else {
          report.dependencies.python_ai_service = 'healthy';
        }
        report.latency.python_ai_service = Date.now() - pyStart;
      }
    } catch (err: any) {
      report.dependencies.python_ai_service = 'unhealthy';
      report.python_ai_service = {
        reachable: false,
        healthy: false,
        ready: false,
        subsystems: { audio_processor: false, vad: false, stt: false, tts: false, embedding: false, reranker: false },
        error: err.message,
      };
      logger.error({ msg: 'Health probe Python AI service check error', err: err.message });
    }

    // 4. Probe Local Qwen LLM
    const llmStart = Date.now();
    if (healthTestOverrides.llmHealthy !== null) {
      report.dependencies.llm = healthTestOverrides.llmHealthy ? 'healthy' : 'unhealthy';
      report.latency.llm = healthTestOverrides.llmLatency ?? (Date.now() - llmStart);
    } else if (config.NODE_ENV === 'test') {
      report.dependencies.llm = 'healthy';
      report.latency.llm = 5;
    } else {
      try {
        const status = await this.probeLocalQwen();
        report.dependencies.llm = status;
        report.latency.llm = Date.now() - llmStart;
      } catch (err: any) {
        report.dependencies.llm = 'unhealthy';
        logger.error({ msg: 'Health probe Local Qwen LLM error', err: err.message });
      }
    }

    // 5. Probe Local Python Embeddings
    const embStart = Date.now();
    if (healthTestOverrides.embeddingsHealthy !== null) {
      report.dependencies.embeddings = healthTestOverrides.embeddingsHealthy ? 'healthy' : 'unhealthy';
      report.latency.embeddings = healthTestOverrides.embeddingsLatency ?? (Date.now() - embStart);
    } else if (config.NODE_ENV === 'test') {
      report.dependencies.embeddings = 'healthy';
      report.latency.embeddings = 5;
    } else {
      try {
        const status = await this.probeLocalEmbeddings();
        report.dependencies.embeddings = status;
        report.latency.embeddings = Date.now() - embStart;
      } catch (err: any) {
        report.dependencies.embeddings = 'unhealthy';
        logger.error({ msg: 'Health probe Local Embeddings error', err: err.message });
      }
    }

    // 6. Classify Overall Status
    const isCoreHealthy = report.dependencies.database === 'healthy' && report.dependencies.redis === 'healthy';
    if (!isCoreHealthy || report.dependencies.python_ai_service === 'unhealthy') {
      report.status = 'unhealthy';
    } else {
      const isPyReady = report.dependencies.python_ai_service === 'healthy';
      const isLlmHealthy = report.dependencies.llm === 'healthy';
      const isEmbHealthy = report.dependencies.embeddings === 'healthy';

      if (!isPyReady || !isLlmHealthy || !isEmbHealthy) {
        report.status = 'degraded';
      } else {
        report.status = 'healthy';
      }
    }

    return report;
  }

  private static async probeLocalQwen(): Promise<'healthy' | 'unhealthy'> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = `${(config.AI_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '')}/api/llm/health`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      if (res.status === 200) {
        const body = (await res.json()) as any;
        return body.ready || body.model_loaded ? 'healthy' : 'unhealthy';
      }
      return 'unhealthy';
    } catch {
      clearTimeout(id);
      return 'unhealthy';
    }
  }

  private static async probeLocalEmbeddings(): Promise<'healthy' | 'unhealthy'> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = `${(config.AI_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '')}/v1/embeddings/status`;
      const res = await fetch(url, {
        headers: {
          'x-internal-api-key': config.INTERNAL_API_KEY,
        },
        signal: controller.signal,
      });
      clearTimeout(id);
      if (res.status === 200) {
        const body = (await res.json()) as any;
        return body.is_ready ? 'healthy' : 'unhealthy';
      }
      return 'unhealthy';
    } catch {
      clearTimeout(id);
      return 'unhealthy';
    }
  }
}
