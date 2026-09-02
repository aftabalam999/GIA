export interface ModelConfig {
  provider: 'gemini' | 'mock';
  model: string;
}

export type ModelType = 'fast' | 'general' | 'reasoning';

/**
 * Centralized model configuration for Afiya.
 * Google Gemini is the single source of conversational intelligence across all model slots.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export const ROUTER_CONFIGS: Record<ModelType, ModelConfig> = {
  fast: {
    provider: 'gemini',
    model: DEFAULT_GEMINI_MODEL,
  },
  general: {
    provider: 'gemini',
    model: DEFAULT_GEMINI_MODEL,
  },
  reasoning: {
    provider: 'gemini',
    model: DEFAULT_GEMINI_MODEL,
  },
};
