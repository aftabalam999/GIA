import { config } from '../../config/index.js';
import { EmbeddingProvider } from './embeddings.interface.js';
import { MockEmbeddingProvider } from './mock.embeddings.js';
import { PythonEmbeddingProvider } from './python.embeddings.js';

let activeProvider: EmbeddingProvider | null = null;
let testProviderOverride: EmbeddingProvider | null = null;

/**
 * Returns the configured EmbeddingProvider according to environment configuration.
 * Defaults to PythonEmbeddingProvider (local Python AI service) for all embeddings,
 * or MockEmbeddingProvider in test environments unless overridden.
 * Completely local, zero cloud dependencies.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (testProviderOverride) return testProviderOverride;
  if (activeProvider) return activeProvider;

  if (process.env.NODE_ENV === 'test' || config.NODE_ENV === 'test') {
    activeProvider = new MockEmbeddingProvider();
    return activeProvider;
  }

  // Pure local Python AI service embeddings
  activeProvider = new PythonEmbeddingProvider();
  return activeProvider;
}

/**
 * Sets a custom provider override (useful for testing custom providers or simulated failures).
 */
export function setTestEmbeddingProvider(provider: EmbeddingProvider | null) {
  testProviderOverride = provider;
}
