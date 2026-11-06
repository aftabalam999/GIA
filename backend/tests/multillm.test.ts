import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { UserRepository } from '../src/database/repositories/user.repository.js';
import { ConversationRepository } from '../src/database/repositories/conversation.repository.js';
import { LLMGateway, setTestProvider } from '../src/ai/router/index.js';
import { ModelRunRepository } from '../src/database/repositories/modelRun.repository.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';

describe('GIA Multi-LLM Gateway and Observability Integration Tests', () => {
  let user: any;
  let conversation: any;

  beforeAll(async () => {
    await initializeDatabase();
    await query('DELETE FROM users');
    user = await UserRepository.create('multi_llm@gia.ai', 'LLM Test User', 'pass_hash');
    conversation = await ConversationRepository.create(user.id, 'LLM Observability Convo');
  });

  afterAll(async () => {
    setTestProvider(null); // Reset override
    await query('DELETE FROM users');
    await pool.end();
  });

  it('should log successfully executed model runs metrics to database', async () => {
    setTestProvider(new MockProvider());

    const request = {
      messages: [{ role: 'user' as const, content: 'Log observability test query' }],
    };

    const response = await LLMGateway.generate(request, {
      conversationId: conversation.id,
      modelType: 'general',
    });

    expect(response.content).toContain('Log observability test query');

    // Wait a brief moment for async log save to commit
    await new Promise((res) => setTimeout(res, 100));

    const runs = await ModelRunRepository.findByConversationId(conversation.id);
    expect(runs.length).toBe(1);
    expect(runs[0].model_name).toBe('mock-model');
    expect(runs[0].provider).toBe('mock');
    expect(runs[0].prompt_tokens).toBeGreaterThan(0);
    expect(runs[0].completion_tokens).toBeGreaterThan(0);
    expect(runs[0].latency_ms).toBeGreaterThanOrEqual(0);
    expect(runs[0].errors).toBeNull();
  });

  it('should log failed model runs errors to database', async () => {
    const mock = new MockProvider();
    mock.setShouldFail(true);
    setTestProvider(mock);

    const request = {
      messages: [{ role: 'user' as const, content: 'Will fail execution' }],
    };

    // Should throw error
    await expect(
      LLMGateway.generate(request, {
        conversationId: conversation.id,
        modelType: 'general',
      })
    ).rejects.toThrow();

    // Wait for log commit
    await new Promise((res) => setTimeout(res, 100));

    const runs = await ModelRunRepository.findByConversationId(conversation.id);
    // There should be 2 runs now (1 success from previous, 1 new failure)
    expect(runs.length).toBe(2);
    // Sorted DESC, runs[0] is the failure
    expect(runs[0].errors).toBeDefined();
    expect(runs[0].errors).toContain('Simulated LLM generation failure');
  });

  it('should recover on transient failures via retries', async () => {
    // Custom mock provider that fails on 1st call, succeeds on 2nd
    let callsCount = 0;
    const transientMock = {
      async generate(req: any) {
        callsCount++;
        if (callsCount === 1) {
          throw new Error('Transient network timeout');
        }
        return {
          content: 'Success after retry',
          model: 'transient-model',
          provider: 'mock',
        };
      },
      async *stream(req: any) {
        yield { content: 'mock' };
      }
    };

    setTestProvider(transientMock);

    const request = {
      messages: [{ role: 'user' as const, content: 'Retry test' }],
    };

    // The call should succeed because it retries and succeeds on 2nd call
    const res = await LLMGateway.generate(request, {
      conversationId: conversation.id,
      modelType: 'general',
    });

    expect(res.content).toBe('Success after retry');
    expect(callsCount).toBe(2); // Verify it was called twice
  });
});
