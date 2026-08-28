import { z } from 'zod';
import { ToolDefinition } from './tool.interface.js';
import { MemoryService } from '../../memories/services/memory.service.js';
import { DocumentService } from '../../documents/services/document.service.js';

class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any, any>>();

  register(tool: ToolDefinition<any, any>) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  clear() {
    this.tools.clear();
  }
}

export const registry = new ToolRegistry();

// --- 1. get_current_time ---
registry.register({
  name: 'get_current_time',
  description: 'Returns the current local system date and time.',
  inputSchema: z.object({}),
  permissions: [],
  riskLevel: 'low',
  timeoutMs: 3000,
  async execute() {
    return { currentTime: new Date().toISOString() };
  },
});

// --- 2. search_memories ---
registry.register({
  name: 'search_memories',
  description: 'Search user memories and preferences semantically using a search query.',
  inputSchema: z.object({
    query: z.string().min(1, 'Search query must not be empty'),
  }),
  permissions: [],
  riskLevel: 'low',
  timeoutMs: 5000,
  async execute(args, context) {
    const memories = await MemoryService.searchMemories(context.userId, args.query);
    return { memories };
  },
});

// --- 3. list_documents ---
registry.register({
  name: 'list_documents',
  description: 'Lists titles and metadata of all documents uploaded by the user.',
  inputSchema: z.object({}),
  permissions: [],
  riskLevel: 'low',
  timeoutMs: 5000,
  async execute(args, context) {
    const docs = await DocumentService.getUserDocuments(context.userId);
    return {
      documents: docs.map((d) => ({
        id: d.id,
        name: d.name,
        mime_type: d.mime_type,
      })),
    };
  },
});
