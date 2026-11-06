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

  async *stream(request: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMChunk> {
    const lastUserMessage = request.messages[request.messages.length - 1]?.content || '';

    if (this.shouldFail || lastUserMessage === 'fail_stream') {
      throw new Error('Simulated LLM stream failure');
    }

    if (signal?.aborted) {
      const err = new Error('Operation aborted');
      err.name = 'AbortError';
      throw err;
    }

    const responseText = `[Mock Stream Response] Echo: "${lastUserMessage}"`;
    for (let i = 0; i < responseText.length; i++) {
      if (signal?.aborted) {
        break;
      }
      yield { content: responseText[i] };
      await new Promise((res) => setTimeout(res, 5));
    }
  }
}
