import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { UserRepository } from '../src/database/repositories/user.repository.js';
import { ConversationRepository } from '../src/database/repositories/conversation.repository.js';
import { MessageRepository } from '../src/database/repositories/message.repository.js';
import { MemoryRepository } from '../src/database/repositories/memory.repository.js';
import { DatabaseError } from '../src/shared/errors.js';

describe('GIA Data Layer Integration Tests', () => {
  beforeAll(async () => {
    await initializeDatabase();
    // Clear test tables to ensure fresh state
    await query('DELETE FROM users');
  });

  afterAll(async () => {
    // Cleanup
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('User Repository CRUD', () => {
    it('should create and retrieve a user', async () => {
      const email = 'test_user@gia.ai';
      const name = 'GIA Test User';

      const user = await UserRepository.create(email, name, 'password_hash_placeholder');
      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.email).toBe(email);
      expect(user.name).toBe(name);

      const found = await UserRepository.findById(user.id);
      expect(found).not.toBeNull();
      expect(found!.email).toBe(email);

      const foundEmail = await UserRepository.findByEmail(email);
      expect(foundEmail).not.toBeNull();
      expect(foundEmail!.id).toBe(user.id);
    });

    it('should update a user name and email', async () => {
      const user = await UserRepository.create('update_me@gia.ai', 'Before Update', 'password_hash_placeholder');
      const updated = await UserRepository.update(user.id, { name: 'After Update', email: 'updated@gia.ai' });
      
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('After Update');
      expect(updated!.email).toBe('updated@gia.ai');
    });

    it('should handle unique constraints error on email', async () => {
      const email = 'duplicate@gia.ai';
      await UserRepository.create(email, 'First User', 'password_hash_placeholder');
      
      // Creating another user with duplicate email must throw DatabaseError
      await expect(
        UserRepository.create(email, 'Second User', 'password_hash_placeholder')
      ).rejects.toThrow(DatabaseError);
    });
  });

  describe('Conversation and Message Relationships', () => {
    it('should handle conversation and messages lifecycle and cascade delete correctly', async () => {
      const user = await UserRepository.create('convo_test@gia.ai', 'Convo User', 'password_hash_placeholder');
      
      // Create conversation
      const conversation = await ConversationRepository.create(
        user.id,
        'Test Conversation',
        'Testing database relationships',
        { test_flag: true }
      );
      expect(conversation).toBeDefined();
      expect(conversation.user_id).toBe(user.id);
      expect(conversation.metadata.test_flag).toBe(true);

      // Create messages
      const msg1 = await MessageRepository.create(conversation.id, 'user', 'Hello GIA');
      const msg2 = await MessageRepository.create(conversation.id, 'assistant', 'Hello, how can I assist you?');

      expect(msg1.content).toBe('Hello GIA');
      expect(msg2.role).toBe('assistant');

      // Fetch history
      const history = await MessageRepository.findByConversationId(conversation.id);
      expect(history.length).toBe(2);
      expect(history[0].id).toBe(msg1.id);
      expect(history[1].id).toBe(msg2.id);

      // Delete user and verify cascade delete on conversation and messages
      await UserRepository.delete(user.id);

      const foundConvo = await ConversationRepository.findById(conversation.id);
      expect(foundConvo).toBeNull();

      const foundMessages = await MessageRepository.findByConversationId(conversation.id);
      expect(foundMessages.length).toBe(0);
    });
  });

  describe('Memory Repository Constraints', () => {
    it('should create and retrieve memories', async () => {
      const user = await UserRepository.create('memory_test@gia.ai', 'Memory User', 'password_hash_placeholder');
      const memory = await MemoryRepository.create(
        user.id,
        'preference',
        'User prefers TypeScript for backend projects',
        8,
        0.95,
        { category: 'programming' }
      );

      expect(memory).toBeDefined();
      expect(memory.user_id).toBe(user.id);
      expect(memory.importance).toBe(8);
      expect(memory.confidence).toBe(0.95);

      const list = await MemoryRepository.findByUserId(user.id);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(memory.id);
    });

    it('should enforce check constraints on memories', async () => {
      const user = await UserRepository.create('constraints_test@gia.ai', 'Constraints User', 'password_hash_placeholder');

      // Importance must be between 1 and 10, confidence between 0.0 and 1.0
      await expect(
        MemoryRepository.create(user.id, 'preference', 'Invalid Importance', 11, 0.95)
      ).rejects.toThrow(DatabaseError);

      await expect(
        MemoryRepository.create(user.id, 'preference', 'Invalid Confidence', 5, 1.2)
      ).rejects.toThrow(DatabaseError);
    });
  });
});
