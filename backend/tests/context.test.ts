import { describe, it, expect } from 'vitest';
import { ContextBuilder, ContextPayload } from '../src/ai/orchestrator/contextBuilder.js';

describe('GIA Context Management Pipeline Tests', () => {
  it('should assemble context with correct prioritizations and structure sections', () => {
    const payload: ContextPayload = {
      systemInstructions: 'You are GIA helper core.',
      appRules: ['Rule A', 'Rule B'],
      userPreferences: ['Theme: Dark'],
      retrievedMemories: [{ content: 'User likes TypeScript', confidence: 0.95 }],
      ragContext: [{ title: 'GIA Docs', content: 'GIA context engine is deterministic.', score: 0.88 }],
      toolResults: [{ name: 'get_current_time', result: { currentTime: '2026-08-29' } }],
      conversationHistory: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
      currentUserRequest: 'Explain context prioritizations',
    };

    const result = ContextBuilder.assembleContext(payload);

    expect(result.systemPrompt).toContain('You are GIA helper core.');
    expect(result.systemPrompt).toContain('=== APPLICATION RULES ===');
    expect(result.systemPrompt).toContain('Rule A');
    expect(result.systemPrompt).toContain('Theme: Dark');
    expect(result.systemPrompt).toContain('=== RETRIEVED USER MEMORY ===');
    expect(result.systemPrompt).toContain('User likes TypeScript');
    expect(result.systemPrompt).toContain('=== RETRIEVED DOCUMENT CONTEXT (RAG) ===');
    expect(result.systemPrompt).toContain('GIA Docs');
    expect(result.systemPrompt).toContain('=== EXECUTED TOOL RESULTS ===');
    expect(result.systemPrompt).toContain('get_current_time');

    // Messages sequence verification
    expect(result.messages.length).toBe(3); // 2 history messages + 1 current request
    expect(result.messages[2].content).toBe('Explain context prioritizations');
    expect(result.messages[2].role).toBe('user');
  });

  it('should enforce budget limits by truncating older conversation history first', () => {
    const payload: ContextPayload = {
      systemInstructions: 'You are GIA.',
      appRules: ['Rule A'],
      userPreferences: [],
      retrievedMemories: [],
      ragContext: [],
      toolResults: [],
      conversationHistory: [
        { role: 'user', content: 'Extremely long message number one in conversation history.' },
        { role: 'assistant', content: 'Another long response from assistant in conversation history.' },
        { role: 'user', content: 'Recent quick message.' },
      ],
      currentUserRequest: 'Help me',
    };

    // Set budget small enough to trigger truncation of older messages
    const result = ContextBuilder.assembleContext(payload, 300);

    // Verify core instructions and current request exist
    expect(result.systemPrompt).toContain('You are GIA.');
    expect(result.messages[result.messages.length - 1].content).toBe('Help me');

    // Verify that older messages were truncated (e.g. total messages count is < 4)
    expect(result.messages.length).toBeLessThan(4);
    
    // Check if the most recent history message is kept, but older ones are truncated
    const hasOlderMessage = result.messages.some(m => m.content.includes('message number one'));
    expect(hasOlderMessage).toBe(false);
  });
});
