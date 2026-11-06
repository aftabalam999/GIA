import { LLMMessage, LLMRequest } from '../providers/provider.interface.js';
import { logger } from '../../shared/logger.js';

export interface ContextPayload {
  systemInstructions?: string;
  appRules?: string[];
  userPreferences?: string[];
  retrievedMemories?: Array<{ content: string; confidence: number }>;
  ragContext?: Array<{ title: string; content: string; score: number }>;
  toolResults?: Array<{ name: string; result: any }>;
  conversationHistory?: Array<{ role: string; content: string }>;
  currentUserRequest: string;
}

export class ContextBuilder {
  /**
   * Deterministically constructs context prompts separating:
   * 1. System instructions (Highest priority)
   * 2. Application rules
   * 3. User preferences
   * 4. Retrieved memory
   * 5. RAG context
   * 6. Tool results
   * 7. Conversation history (Lowest priority - truncated first)
   * Enforces prioritized budget thresholds to fit within available context length.
   */
  static assembleContext(payload: ContextPayload, maxCharLimit = 8000): LLMRequest {
    // 1. Core instructions and rules (Always preserved - Highest Priority)
    const baseSystem = payload.systemInstructions || 'You are GIA, a personal AI assistant.';
    const rules = payload.appRules || [
      'Cites sources explicitly when retrieving document knowledge.',
      'Distinguish clearly between retrieved facts, user preferences, and general model knowledge.',
      'Avoid guaranteeing absolute factual correctness.',
    ];
    
    let systemPrompt = `${baseSystem}\n\n=== APPLICATION RULES ===\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
    let remainingBudget = maxCharLimit - systemPrompt.length;

    // 2. Current User Query (Preserved - High Priority)
    const currentQueryText = `\n=== CURRENT USER REQUEST ===\n${payload.currentUserRequest}`;
    remainingBudget -= currentQueryText.length;

    // 3. User Preferences (High Priority)
    let prefsSection = '';
    const prefs = payload.userPreferences || [];
    if (prefs.length > 0) {
      prefsSection = '\n=== USER PREFERENCES & METADATA ===\n' + prefs.map((p) => `- ${p}`).join('\n');
    }
    
    if (prefsSection.length > 0 && remainingBudget >= prefsSection.length) {
      remainingBudget -= prefsSection.length;
    } else {
      prefsSection = '';
    }

    // 4. Retrieved Memories (Priority 4)
    let memoriesSection = '';
    const memories = payload.retrievedMemories || [];
    if (memories.length > 0) {
      const sortedMemories = [...memories].sort((a, b) => b.confidence - a.confidence);
      let content = '';
      for (const mem of sortedMemories) {
        const line = `- ${mem.content}\n`;
        // Allocate up to 20% of remaining budget
        if (content.length + line.length <= remainingBudget * 0.2) {
          content += line;
        } else {
          break;
        }
      }
      if (content) {
        memoriesSection = '\n=== RETRIEVED USER MEMORY ===\n' + content;
        remainingBudget -= memoriesSection.length;
      }
    }

    // 5. RAG Document Context (Priority 5)
    let ragSection = '';
    const chunks = payload.ragContext || [];
    if (chunks.length > 0) {
      const sortedChunks = [...chunks].sort((a, b) => b.score - a.score);
      let content = '';
      for (const chunk of sortedChunks) {
        const text = `[Document: "${chunk.title}"]:\n${chunk.content}\n\n`;
        // Allocate up to 40% of remaining budget
        if (content.length + text.length <= remainingBudget * 0.4) {
          content += text;
        } else {
          break;
        }
      }
      if (content) {
        ragSection = '\n=== RETRIEVED DOCUMENT CONTEXT (RAG) ===\n' + content;
        remainingBudget -= ragSection.length;
      }
    }

    // 6. Tool Results (Priority 6)
    let toolsSection = '';
    const tools = payload.toolResults || [];
    if (tools.length > 0) {
      let content = '';
      for (const tc of tools) {
        const text = `Tool: "${tc.name}" -> Result: ${JSON.stringify(tc.result)}\n`;
        if (content.length + text.length <= remainingBudget * 0.3) {
          content += text;
        } else {
          break;
        }
      }
      if (content) {
        toolsSection = '\n=== EXECUTED TOOL RESULTS ===\n' + content;
        remainingBudget -= toolsSection.length;
      }
    }

    // Combine system contexts
    const fullSystemInstructions = [
      systemPrompt,
      prefsSection,
      memoriesSection,
      ragSection,
      toolsSection,
    ].filter(Boolean).join('\n');

    // 7. Conversation History (Lowest Priority - Priority 7)
    // Truncates oldest messages first if budget is full
    const history = payload.conversationHistory || [];
    const messagesToInclude: LLMMessage[] = [];
    let historyCharCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const formatMsg: LLMMessage = {
        role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
        content: msg.content,
      };

      const length = formatMsg.content.length + 50;
      if (historyCharCount + length <= remainingBudget) {
        messagesToInclude.unshift(formatMsg); // keep chronological order
        historyCharCount += length;
      } else {
        logger.debug({ msg: 'Truncated older conversation history due to budget exhaustion', index: i });
        break;
      }
    }

    // Include the current request at the end of sequence
    messagesToInclude.push({
      role: 'user',
      content: payload.currentUserRequest,
    });

    return {
      systemPrompt: fullSystemInstructions,
      messages: messagesToInclude,
    };
  }

  /**
   * Backward-compatible wrapper conforming to older message lists format.
   */
  static buildContext(messages: Array<{ role: string; content: string }>): LLMRequest {
    const history = messages.slice(0, -1);
    const lastMsg = messages[messages.length - 1]?.content || '';

    return this.assembleContext({
      currentUserRequest: lastMsg,
      conversationHistory: history,
    });
  }
}
