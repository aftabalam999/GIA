import { config } from '../../config/index.js';
import { LLMGateway } from '../router/index.js';
import { registry } from '../tools/registry.js';
import { logger } from '../../shared/logger.js';

export interface RoutingDecision {
  route: 'direct_response' | 'memory_retrieval' | 'rag' | 'tool' | 'multi_step';
  reason: string;
  requires_memory: boolean;
  requires_rag: boolean;
  requires_tool: boolean;
  tool: { name: string; args: any } | null;
  deterministic?: boolean;
}

export const SAFE_FALLBACK_ROUTE: RoutingDecision = {
  route: 'direct_response',
  reason: 'Fallback triggered due to routing LLM failure or timeout.',
  requires_memory: false,
  requires_rag: false,
  requires_tool: false,
  tool: null,
};

export const routerTestOverrides = {
  mockDecision: null as RoutingDecision | null,
  shouldTimeout: false,
  shouldFail: false,
};

export class AgentRouter {
  static resetOverrides() {
    routerTestOverrides.mockDecision = null;
    routerTestOverrides.shouldTimeout = false;
    routerTestOverrides.shouldFail = false;
  }

  private static matchDeterministicLocalCommand(queryText: string): RoutingDecision | null {
    if (!queryText || typeof queryText !== 'string') return null;
    const trimmed = queryText.trim();

    // 1. Check for VS Code local launch commands
    // Matches: "open VS Code", "open vscode", "launch VS Code", "launch vscode", "can you open vscode", "open <folder> in VS Code", etc.
    const vscodePattern = /(?:(?:can\s+you\s+|please\s+)?(?:open|launch|start)\s+(?:(?:folder|project|app)?\s*(.*?)\s*(?:in|with)?\s*)?(?:vs\s*code|vscode|visual\s*studio\s*code)\b)/i;
    const match = trimmed.match(vscodePattern);

    if (match) {
      const folderArg = match[1] && match[1].trim() ? match[1].trim() : 'GIA-AI';
      return {
        route: 'tool',
        reason: 'Matched deterministic local desktop VS Code command.',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: {
          name: 'open_folder_in_vscode',
          args: { folderName: folderArg || 'GIA-AI' },
        },
        deterministic: true,
      };
    }

    // 2. System Diagnostics & Battery Status
    const sysInfoPattern = /^(?:(?:can\s+you\s+|please\s+)?(?:what\s+is\s+|show\s+(?:me\s+)?|get\s+)?(?:the\s+)?(?:battery(?:\s+status|\s+percentage|\s+level)?|system\s+info(?:rmation)?|laptop\s+specs?|computer\s+specs?|ram\s+usage|memory\s+usage|cpu\s+usage)|system\s+info)$/i;
    if (sysInfoPattern.test(trimmed)) {
      return {
        route: 'tool',
        reason: 'Matched deterministic local system info command.',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: {
          name: 'get_system_info',
          args: {},
        },
        deterministic: true,
      };
    }

    // 3. Open Well-known Folder (Downloads, Desktop, Documents, etc.)
    const openFolderPattern = /^(?:(?:can\s+you\s+|please\s+)?(?:open|launch)\s+(?:my\s+)?(?:folder|directory\s+)?(downloads|desktop|documents|pictures|music|videos|home|projects)\b(?:\s+folder)?)$/i;
    const folderMatch = trimmed.match(openFolderPattern);
    if (folderMatch) {
      const folderName = folderMatch[1];
      return {
        route: 'tool',
        reason: 'Matched deterministic local folder open command.',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: {
          name: 'open_file_or_folder',
          args: { targetPath: folderName },
        },
        deterministic: true,
      };
    }

    // 4. List Directory / Browse Files
    const listDirPattern = /^(?:(?:can\s+you\s+|please\s+)?(?:list|show|view|display)\s+(?:all\s+)?(?:files|items|folders|contents|what(?:\s*'?s|\s+is))\s*(?:in|on|inside|of)?\s*(downloads|desktop|documents|projects|home|.*)?)$/i;
    const listMatch = trimmed.match(listDirPattern);
    if (listMatch && (trimmed.toLowerCase().includes('files') || trimmed.toLowerCase().includes('contents') || trimmed.toLowerCase().includes('what is in') || trimmed.toLowerCase().includes('what\'s in'))) {
      const dirArg = listMatch[1] && listMatch[1].trim() ? listMatch[1].trim() : 'Desktop';
      return {
        route: 'tool',
        reason: 'Matched deterministic local list directory command.',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: {
          name: 'list_directory',
          args: { directoryPath: dirArg },
        },
        deterministic: true,
      };
    }

    // 5. Open Application (Chrome, Brave, Safari, Spotify, Terminal, Calculator, Notes, Finder, etc.)
    const KNOWN_APPS = new Set([
      'chrome', 'google chrome', 'brave', 'brave browser', 'safari', 'firefox',
      'terminal', 'iterm', 'iterm2', 'calculator', 'spotify', 'notes', 'apple notes',
      'finder', 'calendar', 'settings', 'system settings', 'system preferences',
      'mail', 'music', 'apple music', 'slack', 'discord', 'whatsapp', 'messages',
      'textedit', 'preview', 'photos', 'reminders', 'activity monitor', 'vlc',
      'pycharm', 'dbeaver', 'obs', 'sublime', 'telegram', 'zoom'
    ]);

    const openAppMatch = trimmed.match(/^(?:(?:can\s+you\s+|please\s+)?(?:open|launch|start|run)\s+(?:the\s+)?(?:app(?:lication)?\s+)?([a-zA-Z0-9\s._-]+?)(?:\s+app)?)$/i);
    if (openAppMatch) {
      const candidate = openAppMatch[1].trim().toLowerCase();
      if (KNOWN_APPS.has(candidate) || trimmed.toLowerCase().includes('app ') || trimmed.toLowerCase().endsWith(' app')) {
        return {
          route: 'tool',
          reason: 'Matched deterministic local application open command.',
          requires_memory: false,
          requires_rag: false,
          requires_tool: true,
          tool: {
            name: 'open_application',
            args: { appName: openAppMatch[1].trim() },
          },
          deterministic: true,
        };
      }
    }

    // 6. Read File Content
    const readFilePattern = /^(?:(?:can\s+you\s+|please\s+)?(?:read|cat|display|show\s+content\s+of|print)\s+(?:file\s+)?([a-zA-Z0-9_./~-]+\.[a-zA-Z0-9]+))$/i;
    const readFileMatch = trimmed.match(readFilePattern);
    if (readFileMatch) {
      return {
        route: 'tool',
        reason: 'Matched deterministic local read file command.',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: {
          name: 'read_file_content',
          args: { filePath: readFileMatch[1].trim() },
        },
        deterministic: true,
      };
    }

    // 7. Search / Find Files
    const searchFilePattern = /^(?:(?:can\s+you\s+|please\s+)?(?:find|search(?:\s+for)?|locate)\s+(?:file|folder)?\s*["']?([a-zA-Z0-9_.-]+)["']?)$/i;
    const searchFileMatch = trimmed.match(searchFilePattern);
    if (searchFileMatch && !trimmed.toLowerCase().includes('memory') && !trimmed.toLowerCase().includes('document')) {
      return {
        route: 'tool',
        reason: 'Matched deterministic local search files command.',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: {
          name: 'search_files',
          args: { query: searchFileMatch[1].trim() },
        },
        deterministic: true,
      };
    }

    return null;
  }

  static async route(queryText: string, userId: string): Promise<RoutingDecision> {
    const start = Date.now();

    // 1. Handle test overrides
    if (routerTestOverrides.shouldFail) {
      logger.warn({ msg: 'Routing fallback triggered via test failure override' });
      return SAFE_FALLBACK_ROUTE;
    }
    if (routerTestOverrides.shouldTimeout) {
      logger.warn({ msg: 'Routing fallback triggered via test timeout override' });
      return SAFE_FALLBACK_ROUTE;
    }
    if (routerTestOverrides.mockDecision) {
      // Validate mock policy first
      const isValid = this.validatePolicy(routerTestOverrides.mockDecision);
      return isValid ? routerTestOverrides.mockDecision : SAFE_FALLBACK_ROUTE;
    }

    // 2. Deterministic local command detection (bypasses LLM)
    const localMatch = this.matchDeterministicLocalCommand(queryText);
    if (localMatch) {
      logger.info({
        msg: 'Deterministic local command matched, bypassing LLM router',
        queryText,
        tool: localMatch.tool?.name,
      });
      return localMatch;
    }

    // 3. Perform Routing LLM Call
    try {
      const systemPrompt = `You are the Routing Router for GIA, a personal intelligent assistant.
Your task is to analyze the user's input query and determine the most appropriate routing path.
You must output a single JSON object matching this schema:
{
  "route": "direct_response" | "memory_retrieval" | "rag" | "tool" | "multi_step",
  "reason": "short explanation of the decision",
  "requires_memory": boolean,
  "requires_rag": boolean,
  "requires_tool": boolean,
  "tool": { "name": string, "args": object } | null
}

Available Routes:
1. "direct_response": For general conversational queries, chit-chat, simple formatting, explanations, or questions that do not require external tools, memories, or custom documents.
2. "memory_retrieval": For queries asking about user preferences, personal facts, things to remember, or retrieving specific user notes.
3. "rag": For queries asking about uploaded documents, guides, manuals, text files, or factual knowledge retrieval from user's document index.
4. "tool": For queries requesting execution of a specific system tool. Available tools:
   - "get_current_time": Get the current date and time (arguments: {}).
   - "search_memories": Search user memories semantically (arguments: { "query": string }).
   - "list_documents": List all document metadata uploaded (arguments: {}).
   - "open_url": Opens a specified web browser URL (arguments: { "url": string }).
   - "open_application": Opens and launches any desktop application on the laptop (arguments: { "appName": string }).
   - "open_file_or_folder": Opens any local file or folder in Finder/default viewer (arguments: { "targetPath": string }).
   - "list_directory": Lists files and folders inside a directory on the laptop (arguments: { "directoryPath": string }).
   - "read_file_content": Reads text, code, or config file contents (arguments: { "filePath": string, "maxLines": number }).
   - "search_files": Searches for files or folders matching a query pattern (arguments: { "query": string, "directory": string }).
   - "get_system_info": Returns hardware, OS, battery, memory, CPU, and laptop diagnostics (arguments: {}).
   - "open_folder_in_vscode": Opens a specified folder/project on the user's desktop in VS Code (arguments: { "folderName": string }).
   - "run_project_frontend": Runs the dev frontend script inside the specified project folder (arguments: { "folderName": string, "scriptName": string }).
5. "multi_step": For complex queries requiring multiple operations (e.g. retrieving documents AND checking the time).

Constraints:
- If no external data, tools, or memory are needed, select "direct_response".
- For "tool" route, the "tool" property must be set with the correct name and arguments. Only use registered tools.
- Output ONLY valid JSON. No other text.`;

      // Set a short routing deadline timeout of 5 seconds to ensure fast response.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      let response;
      try {
        response = await LLMGateway.generate(
          {
            systemPrompt,
            messages: [{ role: 'user', content: queryText }],
            temperature: 0.0, // force deterministic decisions
            responseFormat: 'json',
            maxTokens: 80,
            enableThinking: false,
          },
          { modelType: 'fast' }
        );
      } finally {
        clearTimeout(timeoutId);
      }

      const decision = JSON.parse(response.content) as RoutingDecision;

      // 3. Schema & Backend Policy Verification
      const isValid = this.validatePolicy(decision);
      
      const latency = Date.now() - start;
      logger.info({
        msg: 'Routing LLM completion details',
        route: decision.route,
        latency,
        model: response.model,
        provider: response.provider,
        isValid,
      });

      if (!isValid) {
        logger.warn({ msg: 'Routing decision failed backend policy validation', decision });
        return SAFE_FALLBACK_ROUTE;
      }

      return decision;
    } catch (err: any) {
      logger.error({ msg: 'Routing LLM call failed, falling back to direct response', error: err.message });
      return SAFE_FALLBACK_ROUTE;
    }
  }

  /**
   * Authoritative backend policy validation.
   */
  private static validatePolicy(decision: any): boolean {
    if (!decision || typeof decision !== 'object') return false;

    // Validate route enum
    const validRoutes = ['direct_response', 'memory_retrieval', 'rag', 'tool', 'multi_step'];
    if (!validRoutes.includes(decision.route)) return false;

    // Validate boolean fields
    if (typeof decision.requires_memory !== 'boolean') return false;
    if (typeof decision.requires_rag !== 'boolean') return false;
    if (typeof decision.requires_tool !== 'boolean') return false;

    // Validate tool constraints
    if (decision.requires_tool || decision.route === 'tool' || decision.tool) {
      if (!decision.tool || typeof decision.tool !== 'object') return false;
      if (typeof decision.tool.name !== 'string') return false;
      if (!decision.tool.args || typeof decision.tool.args !== 'object') return false;

      // Assert tool is registered in the GIA tool registry
      const registeredTool = registry.get(decision.tool.name);
      if (!registeredTool) {
        logger.warn({ msg: 'Rejected route proposing unregistered tool', toolName: decision.tool.name });
        return false;
      }
    }

    return true;
  }
}
