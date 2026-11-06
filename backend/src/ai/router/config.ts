export interface ModelConfig {
  provider: 'qwen' | 'mock';
  model: string;
}

export type ModelType = 'fast' | 'general' | 'reasoning';

/**
 * Centralized model configuration for GIA.
 * The local Qwen 3.5 4B model is the ONLY LLM throughout the project across all model slots.
 * Fully offline, private, and hosted on the local Python AI inference service.
 */
export const DEFAULT_QWEN_MODEL = 'Qwen3.5-4B';

export const ROUTER_CONFIGS: Record<ModelType, ModelConfig> = {
  fast: {
    provider: 'qwen',
    model: DEFAULT_QWEN_MODEL,
  },
  general: {
    provider: 'qwen',
    model: DEFAULT_QWEN_MODEL,
  },
  reasoning: {
    provider: 'qwen',
    model: DEFAULT_QWEN_MODEL,
  },
};
