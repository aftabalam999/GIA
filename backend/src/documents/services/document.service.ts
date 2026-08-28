import { DocumentRepository, Document } from '../../database/repositories/document.repository.js';
import { DocumentChunkRepository } from '../../database/repositories/documentChunk.repository.js';
import { getEmbeddingProvider } from '../../ai/embeddings/router.js';
import { logger } from '../../shared/logger.js';
import { ValidationError, NotFoundError, AuthorizationError } from '../../shared/errors.js';

export class DocumentService {
  /**
   * Ingests a new document, parses it into paragraph-based chunks, and generates pgvector embeddings.
   */
  static async createDocument(
    userId: string,
    title: string,
    content: string,
    sourceType: string,
    sourceUrl: string | null = null,
    metadata: Record<string, any> = {}
  ): Promise<Document> {
    if (!content.trim()) {
      throw new ValidationError('Document content cannot be empty');
    }

    // 1. Save document record
    const doc = await DocumentRepository.create(
      userId,
      title, // name
      sourceUrl || '', // file_url (non-null in schema)
      sourceType, // mime_type
      content.length, // file_size
      metadata
    );

    // 2. Chunking strategy: split by double newlines or punctuation limits
    const paragraphs = content
      .split('\n\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const chunks: string[] = [];
    for (const paragraph of paragraphs) {
      // Divide very large paragraphs into chunks of ~500 characters
      if (paragraph.length > 600) {
        let remaining = paragraph;
        while (remaining.length > 0) {
          const part = remaining.slice(0, 500);
          chunks.push(part);
          remaining = remaining.slice(500);
        }
      } else {
        chunks.push(paragraph);
      }
    }

    if (chunks.length === 0) {
      chunks.push(content.trim());
    }

    // 3. Process vector embeddings
    const embeddingProvider = getEmbeddingProvider();
    for (let index = 0; index < chunks.length; index++) {
      const chunkText = chunks[index];
      try {
        const chunk = await DocumentChunkRepository.create(doc.id, index, chunkText);
        const vector = await embeddingProvider.embed(chunkText);
        await DocumentChunkRepository.updateEmbedding(chunk.id, vector);
      } catch (err: any) {
        logger.error({
          msg: `Ingestion failed to generate chunk embedding at index ${index}`,
          docId: doc.id,
          err: err.message,
        });
      }
    }

    return doc;
  }

  static async getDocumentById(userId: string, id: string): Promise<Document> {
    const doc = await DocumentRepository.findById(id);
    if (!doc) {
      throw new NotFoundError('Document not found');
    }
    if (doc.user_id !== userId) {
      throw new AuthorizationError('Access denied to this document');
    }
    return doc;
  }

  static async getUserDocuments(userId: string): Promise<Document[]> {
    return DocumentRepository.findByUserId(userId);
  }

  static async deleteDocument(userId: string, id: string): Promise<boolean> {
    await this.getDocumentById(userId, id); // Enforce owner check
    return DocumentRepository.delete(id);
  }
}
