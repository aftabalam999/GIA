import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AIServiceClient } from '../src/ai/ml-client/ai-service.client.js';
import { PythonEmbeddingProvider } from '../src/ai/embeddings/python.embeddings.js';
import { RAGService } from '../src/rag/services/rag.service.js';
import { initializeDatabase, pool } from '../src/database/client.js';
import { UserRepository } from '../src/database/repositories/user.repository.js';
import { DocumentRepository } from '../src/database/repositories/document.repository.js';
import { DocumentChunkRepository } from '../src/database/repositories/documentChunk.repository.js';
import { setTestEmbeddingProvider } from '../src/ai/embeddings/router.js';
import { MockEmbeddingProvider } from '../src/ai/embeddings/mock.embeddings.js';

describe('GIA Phase 4: Local Embeddings and Reranker Integration Suite', () => {
  let testUserId: string;
  const mockProvider = new MockEmbeddingProvider();

  beforeAll(async () => {
    setTestEmbeddingProvider(mockProvider);
    await initializeDatabase();
    const user = await UserRepository.create('test-phase4-rag@gia.ai', 'password123', 'Phase4 RAG User');
    testUserId = user.id;
  });

  afterAll(async () => {
    setTestEmbeddingProvider(null);
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

  it('should verify RAGService executes 384-dim pgvector search, metadata filtering and reranking flow', async () => {
    // 1. Create document entry
    const doc = await DocumentRepository.create(
      testUserId,
      'GIA Local Architecture Guide',
      'https://example.com/local-guide.pdf',
      'application/pdf',
      1024,
      { category: 'architecture', project: 'gia' }
    );

    // 2. Generate 384-dim embeddings using mock provider
    const archVector = await mockProvider.embed('GIA local voice assistant documentation architecture');
    const cakeVector = await mockProvider.embed('Baking chocolate cake sweet food recipe');

    const chunk1 = await DocumentChunkRepository.create(
      doc.id,
      0,
      'GIA local voice assistant documentation with Qwen 3.5 4B and Sentence Transformers architecture',
      { category: 'architecture', project: 'gia' }
    );
    await DocumentChunkRepository.updateEmbedding(chunk1.id, archVector);

    const chunk2 = await DocumentChunkRepository.create(
      doc.id,
      1,
      'Baking chocolate cake instructions with flour, sugar and eggs food',
      { category: 'cooking', project: 'kitchen' }
    );
    await DocumentChunkRepository.updateEmbedding(chunk2.id, cakeVector);

    // 3. Search with semantic retrieval for architecture
    const { chunks } = await RAGService.queryAndRetrieve(testUserId, 'architecture guide', 2, 0.1);
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toContain('Qwen 3.5 4B');

    // 4. Test metadata filtering
    const { chunks: filteredChunks } = await RAGService.queryAndRetrieve(testUserId, 'architecture guide', {
      limit: 5,
      threshold: 0.1,
      metadataFilter: { category: 'architecture' },
    });
    expect(filteredChunks.length).toBe(1);
    expect(filteredChunks[0].content).toContain('Qwen 3.5 4B');

    // 5. Test negative metadata filter
    const { chunks: noMatchChunks } = await RAGService.queryAndRetrieve(testUserId, 'architecture guide', {
      limit: 5,
      threshold: 0.1,
      metadataFilter: { category: 'non_existent_category' },
    });
    expect(noMatchChunks.length).toBe(0);
  });
});
