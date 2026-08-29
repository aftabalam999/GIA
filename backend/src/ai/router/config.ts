export interface ModelConfig {
  provider: 'openai' | 'gemini' | 'anthropic' | 'mock';
  model: string;
}

export type ModelType = 'fast' | 'general' | 'reasoning';

/**
 * Global mappings associating semantic model aliases to provider-specific targets.
 */
export const ROUTER_CONFIGS: Record<ModelType, ModelConfig> = {
  fast: {
    provider: 'gemini',
    model: 'gemini-3.6-flash',
  },
  general: {
    provider: 'gemini',
    model: 'gemini-3.6-flash', // switched from openai: no credits
  },
  reasoning: {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
  },
};
