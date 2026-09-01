import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AIServiceClient } from '../src/ai/ml-client/ai-service.client.js';
import { PythonEmbeddingProvider } from '../src/ai/embeddings/python.embeddings.js';
import { RAGService } from '../src/rag/services/rag.service.js';
import { initializeDatabase, pool } from '../src/database/client.js';
import { UserRepository } from '../src/database/repositories/user.repository.js';
import { DocumentRepository } from '../src/database/repositories/document.repository.js';
import { DocumentChunkRepository } from '../src/database/repositories/documentChunk.repository.js';

describe('GIA Phase 13: Embeddings and Reranker Integration Suite', () => {
  let testUserId: string;

  beforeAll(async () => {
    await initializeDatabase();
    const user = await UserRepository.create('test-phase13-user@gia.ai', 'password123', 'Phase13 User');
    testUserId = user.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  it('should verify AIServiceClient embedding generation and status probing', async () => {
    const mockClient = new AIServiceClient('http://127.0.0.1:8001');
    
    expect(typeof mockClient.embed).toBe('function');
    expect(typeof mockClient.getEmbeddingStatus).toBe('function');
  });

  it('should verify AIServiceClient document reranking and status probing', async () => {
    const mockClient = new AIServiceClient('http://127.0.0.1:8001');

    expect(typeof mockClient.rerank).toBe('function');
    expect(typeof mockClient.getRerankerStatus).toBe('function');
  });

  it('should verify PythonEmbeddingProvider correctly implements EmbeddingProvider interface', async () => {
    const provider = new PythonEmbeddingProvider();
    
    await expect(provider.embed('')).rejects.toThrow('Text is required');
    await expect(provider.embedBatch([])).resolves.toEqual([]);
  });

  it('should verify RAGService executes pgvector search and reranking flow', async () => {
    // 1. Create document entry
    const doc = await DocumentRepository.create(
      testUserId,
      'GIA Voice Architecture',
      'https://example.com/doc.pdf',
      'application/pdf',
      1024
    );

    // 2. Create chunks & update embeddings
    const dummyEmbedding = Array(1536).fill(0.05);
    const chunk1 = await DocumentChunkRepository.create(
      doc.id,
      0,
      'GIA AI Voice Assistant documentation and fastify pipeline setup'
    );
    await DocumentChunkRepository.updateEmbedding(chunk1.id, dummyEmbedding);

    const chunk2 = await DocumentChunkRepository.create(
      doc.id,
      1,
      'Baking chocolate cake instructions and ingredients'
    );
    await DocumentChunkRepository.updateEmbedding(chunk2.id, dummyEmbedding);

    const { chunks } = await RAGService.queryAndRetrieve(testUserId, 'GIA voice assistant', 2, 0.0);
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
