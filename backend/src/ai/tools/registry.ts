import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ToolDefinition } from './tool.interface.js';
import { MemoryService } from '../../memories/services/memory.service.js';
import { DocumentService } from '../../documents/services/document.service.js';

// Configurable workspace root. Override via GIA_WORKSPACE_DIR env var.
// Defaults to ~/Desktop — works on Linux/macOS without hardcoding a username.
const WORKSPACE_BASE_DIR = process.env.GIA_WORKSPACE_DIR
  ? path.resolve(process.env.GIA_WORKSPACE_DIR)
  : path.join(os.homedir(), 'Desktop');

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any, any>>();

  register(tool: ToolDefinition<any, any>) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  getAll(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  clear() {
    this.tools.clear();
  }
}

export const registry = new ToolRegistry();

// Helper to resolve folders with path traversal protection and ambiguity checks
interface ResolutionSuccess {
  success: true;
  path: string;
}

interface ResolutionFailure {
  success: false;
  ambiguity: boolean;
  options: string[];
  error: string;
}

type ResolutionResult = ResolutionSuccess | ResolutionFailure;

function resolveProjectFolder(baseDir: string, folderName: string): ResolutionResult {
  // 1. Path traversal check immediately using user's home directory
  const homeDir = os.homedir();
  const resolvedInput = path.resolve(homeDir, folderName);
  if (!resolvedInput.startsWith(homeDir)) {
    return {
      success: false,
      ambiguity: false,
      options: [],
      error: 'Access denied: Path traversal detected',
    };
  }

  const normalizedSearch = folderName.toLowerCase().replace(/[-_]/g, ' ');

  // 2. Scan home directory recursively up to depth 3 to discover project folders
  const skipFolders = new Set([
    'node_modules', '.git', '.npm', '.cargo', '.rustup', '.cache', '.local',
    '.config', '.vscode', '.idea', 'snap', 'dist', 'build', 'target',
    '.gemini', '.agents', '.astro', 'Library', 'Pictures', 'Music', 'Videos',
    'Templates', 'Public'
  ]);

  const matches: string[] = [];

  function scan(dir: string, depth: number) {
    if (depth > 3) return;

    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') && entry !== '.env') {
          continue;
        }
        if (skipFolders.has(entry)) {
          continue;
        }

        const fullPath = path.join(dir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const normalizedEntry = entry.toLowerCase().replace(/[-_]/g, ' ');
            if (normalizedEntry === normalizedSearch || normalizedEntry.includes(normalizedSearch)) {
              matches.push(fullPath);
            }
            // Recurse to next level
            scan(fullPath, depth + 1);
          }
        } catch (e) {
          // ignore stat errors
        }
      }
    } catch (e) {
      // ignore read errors
    }
  }

  scan(homeDir, 1);

  if (matches.length === 0) {
    return {
      success: false,
      ambiguity: false,
      options: [],
      error: `Folder "${folderName}" could not be located in home directory`,
    };
  }

  // Deduplicate matches to prevent matching parent and child paths if both contain searchName
  const uniqueMatches = Array.from(new Set(matches));

  // If there's an exact basename match, prioritize it immediately to bypass ambiguity
  const exactMatch = uniqueMatches.find(m => path.basename(m).toLowerCase().replace(/[-_]/g, ' ') === normalizedSearch);
  if (exactMatch) {
    return {
      success: true,
      path: exactMatch,
    };
  }

  if (uniqueMatches.length > 1) {
    const options = uniqueMatches.map((m) => path.basename(m));
    return {
      success: false,
      ambiguity: true,
      options,
      error: `Ambiguity detected: Multiple matching folders found: ${options.join(', ')}. Please specify which one you meant.`,
    };
  }

  return {
    success: true,
    path: uniqueMatches[0],
  };
}

// --- 1. get_current_time ---
registry.register({
  name: 'get_current_time',
  description: 'Returns the current local system date and time.',
  inputSchema: z.object({}),
  permissions: [],
  riskLevel: 'low',
  operationType: 'read',
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
  operationType: 'read',
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
  operationType: 'read',
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

// --- 4. open_url ---
registry.register({
  name: 'open_url',
  description: 'Opens a specified web browser URL using default handler.',
  inputSchema: z.object({
    url: z.string().url('A valid URL must be provided'),
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 5000,
  async execute(args) {
    const cleanUrl = args.url.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      throw new Error('Invalid protocol. Only http/https are allowed.');
    }

    return new Promise((resolve, reject) => {
      import('child_process').then(({ spawn }) => {
        const child = spawn('xdg-open', [cleanUrl]);
        child.on('error', (err) => {
          reject(new Error(`Failed to open URL: ${err.message}`));
        });
        resolve({ success: true, openedUrl: cleanUrl });
      }).catch(reject);
    });
  },
});

// --- 5. open_folder_in_vscode ---
registry.register({
  name: 'open_folder_in_vscode',
  description: 'Opens a specified folder/project on the user\'s desktop inside VS Code.',
  inputSchema: z.object({
    folderName: z.string().min(1, 'Folder name must be provided'),
  }),
  permissions: ['open:folders'],
  riskLevel: 'medium',
  operationType: 'execute',
  timeoutMs: 7000,
  async execute(args) {
    const { spawn } = await import('child_process');
    const baseDir = WORKSPACE_BASE_DIR;

    const resolution = resolveProjectFolder(baseDir, args.folderName);
    if (!resolution.success) {
      if (resolution.ambiguity) {
        return {
          success: false,
          ambiguity: true,
          options: resolution.options,
          error: resolution.error,
        };
      }
      throw new Error(resolution.error);
    }

    const resolvedPath = resolution.path;

    return new Promise((resolve, reject) => {
      const child = spawn('code', [resolvedPath]);

      child.on('error', (err) => {
        const fallback = spawn('code-insiders', [resolvedPath]);
        fallback.on('error', (fallbackErr) => {
          reject(new Error(`Failed to spawn VS Code: CLI code launcher not found. (${fallbackErr.message})`));
        });
      });

      resolve({ success: true, folderOpened: resolvedPath });
    });
  },
});

// --- 6. run_project_frontend ---
registry.register({
  name: 'run_project_frontend',
  description: 'Runs the dev frontend script inside the specified project folder.',
  inputSchema: z.object({
    folderName: z.string().min(1, 'Folder name must be provided'),
    scriptName: z.string().optional(),
  }),
  permissions: ['run:commands'],
  riskLevel: 'high',
  operationType: 'execute',
  timeoutMs: 10000,
  async execute(args) {
    const { spawn } = await import('child_process');
    const baseDir = WORKSPACE_BASE_DIR;

    const resolution = resolveProjectFolder(baseDir, args.folderName);
    if (!resolution.success) {
      if (resolution.ambiguity) {
        return {
          success: false,
          ambiguity: true,
          options: resolution.options,
          error: resolution.error,
        };
      }
      throw new Error(resolution.error);
    }

    const resolvedPath = resolution.path;

    let targetPath = resolvedPath;
    if (fs.existsSync(path.join(resolvedPath, 'frontend', 'package.json'))) {
      targetPath = path.join(resolvedPath, 'frontend');
    }

    if (!fs.existsSync(path.join(targetPath, 'package.json'))) {
      throw new Error(`No package.json file found in "${targetPath}"`);
    }

    // Safely inspect package.json to determine script if not specified
    let scriptToRun = args.scriptName;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(targetPath, 'package.json'), 'utf-8'));
      if (!scriptToRun && pkg.scripts) {
        if (pkg.scripts.dev) {
          scriptToRun = 'dev';
        } else if (pkg.scripts.start) {
          scriptToRun = 'start';
        } else if (pkg.scripts.serve) {
          scriptToRun = 'serve';
        } else {
          const scripts = Object.keys(pkg.scripts);
          if (scripts.length > 0) {
            scriptToRun = scripts[0];
          }
        }
      }
    } catch (err: any) {
      throw new Error(`Failed to parse package.json: ${err.message}`);
    }

    if (!scriptToRun) {
      scriptToRun = 'dev';
    }

    if (!/^[a-zA-Z0-9:-]+$/.test(scriptToRun)) {
      throw new Error('Access denied: Invalid script name syntax');
    }

    return new Promise((resolve) => {
      const child = spawn('npm', ['run', scriptToRun], {
        cwd: targetPath,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      resolve({
        success: true,
        message: `Dev server command "npm run ${scriptToRun}" spawned in background.`,
        targetDir: targetPath,
        scriptRun: scriptToRun,
      });
    });
  },
});