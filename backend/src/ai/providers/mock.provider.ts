import { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from './provider.interface.js';

export class MockProvider implements LLMProvider {
  private shouldFail = false;

  constructor(shouldFail = false) {
    this.shouldFail = shouldFail;
  }

  setShouldFail(val: boolean) {
    this.shouldFail = val;
  }

  async generate(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const lastUserMessage = request.messages[request.messages.length - 1]?.content || '';
    
    if (this.shouldFail || lastUserMessage === 'fail_generation') {
      throw new Error('Simulated LLM generation failure');
    }

    if (request.responseFormat === 'json') {
      const query = lastUserMessage.toLowerCase();
      let route = 'direct_response';
      let requires_memory = false;
      let requires_rag = false;
      let requires_tool = false;
      let tool = null;

      if (query.includes('time') || query.includes('clock') || query.includes('date')) {
        route = 'tool';
        requires_tool = true;
        tool = { name: 'get_current_time', args: {} };
      } else if (
        query.includes('python') ||
        query.includes('chocolate') ||
        query.includes('guide') ||
        query.includes('remember') ||
        query.includes('preference')
      ) {
        route = 'rag';
        requires_rag = true;
      }

      return {
        content: JSON.stringify({
          route,
          reason: 'Mock routing decision',
          requires_memory,
          requires_rag,
          requires_tool,
          tool,
        }),
        model: 'mock-model',
        provider: 'mock',
      };
    }

    return {
      content: `[Mock Response] You said: "${lastUserMessage}"`,
      model: 'mock-model',
      provider: 'mock',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMChunk> {
    const lastUserMessage = request.messages[request.messages.length - 1]?.content || '';

    if (this.shouldFail || lastUserMessage === 'fail_stream') {
      throw new Error('Simulated LLM stream failure');
    }

    const responseText = `[Mock Stream Response] Echo: "${lastUserMessage}"`;
    // Split by character or word. Split by character is standard for fast updates
    for (let i = 0; i < responseText.length; i++) {
      yield { content: responseText[i] };
      // Simulated small delay
      await new Promise((res) => setTimeout(res, 5));
    }
  }
}
