import { config } from '../../config/index.js';
import { EmbeddingProvider } from './embeddings.interface.js';
import { MockEmbeddingProvider } from './mock.embeddings.js';
import { OpenAIEmbeddingProvider } from './openai.embeddings.js';

let activeProvider: EmbeddingProvider | null = null;
let testProviderOverride: EmbeddingProvider | null = null;

/**
 * Returns the configured EmbeddingProvider according to environment configuration.
 * Defaults to MockEmbeddingProvider in test environments or if API keys are absent.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (testProviderOverride) return testProviderOverride;
  if (activeProvider) return activeProvider;

  if (config.NODE_ENV === 'test') {
    activeProvider = new MockEmbeddingProvider();
    return activeProvider;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    activeProvider = new MockEmbeddingProvider();
    return activeProvider;
  }

  activeProvider = new OpenAIEmbeddingProvider(apiKey);
  return activeProvider;
}

/**
 * Sets a custom provider override (useful for testing custom providers or simulated failures).
 */
export function setTestEmbeddingProvider(provider: EmbeddingProvider | null) {
  testProviderOverride = provider;
}
