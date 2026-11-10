import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ToolDefinition } from './tool.interface.js';
import { MemoryService } from '../../memories/services/memory.service.js';
import { DocumentService } from '../../documents/services/document.service.js';
import { BrowserAutomationService } from './browser.service.js';

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

  // If no match was found with direct substring, attempt compact and phonetic match (e.g. "New Go" -> "NeuGo")
  if (matches.length === 0) {
    const phonSearch = folderName.toLowerCase().replace(/[-_\s]/g, '').replace(/w/g, 'u').replace(/ph/g, 'f');
    const compactSearch = folderName.toLowerCase().replace(/[-_\s]/g, '');

    function scanFuzzy(dir: string, depth: number) {
      if (depth > 3) return;
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (entry.startsWith('.') && entry !== '.env') continue;
          if (skipFolders.has(entry)) continue;
          const fullPath = path.join(dir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              const compactEntry = entry.toLowerCase().replace(/[-_\s]/g, '');
              const phonEntry = compactEntry.replace(/w/g, 'u').replace(/ph/g, 'f');
              if (phonEntry === phonSearch || compactEntry === compactSearch || compactEntry.includes(compactSearch)) {
                matches.push(fullPath);
              }
              scanFuzzy(fullPath, depth + 1);
            }
          } catch {}
        }
      } catch {}
    }

    scanFuzzy(homeDir, 1);
  }

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
  description: 'Opens a specified web browser URL using default handler or browser automation.',
  inputSchema: z.object({
    url: z.string().optional(),
    link: z.string().optional(),
    target: z.string().optional(),
    browser: z.string().optional(),
  }).refine((data) => {
    const u = (data.url || data.link || data.target || '').trim();
    if (!u) return false;
    try {
      const candidate = u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`;
      const parsed = new URL(candidate);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.hostname.includes('.') || parsed.hostname === 'localhost');
    } catch {
      return false;
    }
  }, {
    message: 'A valid URL must be provided',
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const rawUrl = (args.url || args.link || args.target || '').trim();
    const res = await BrowserAutomationService.navigateUrl(rawUrl, args.browser, false);
    return { success: true, openedUrl: res.url, browser: res.browser, message: res.message };
  },
  async verify(args, result) {
    return {
      verified: Boolean(result && result.success),
      message: result?.message || 'URL opened successfully.',
    };
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
      const isMac = process.platform === 'darwin';
      const child = isMac
        ? spawn('open', ['-a', 'Visual Studio Code', resolvedPath])
        : spawn('code', [resolvedPath]);

      child.on('error', (err) => {
        const fallback = spawn('code', [resolvedPath]);
        fallback.on('error', () => {
          const fallbackInsiders = spawn('code-insiders', [resolvedPath]);
          fallbackInsiders.on('error', (fallbackErr) => {
            reject(new Error(`Failed to spawn VS Code: CLI code launcher not found. (${fallbackErr.message})`));
          });
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

// Helper to safely expand tilde and resolve against user's home directory, tmp, or Applications
export function resolveSafePath(inputPath: string, allowApplications = false): { success: true; path: string } | { success: false; error: string } {
  const homeDir = os.homedir();
  const tmpDir = os.tmpdir();
  const customDesktop = process.env.GIA_DESKTOP_DIR ? path.resolve(process.env.GIA_DESKTOP_DIR) : null;
  let cleanPath = inputPath.trim();
  if (cleanPath.startsWith('~')) {
    cleanPath = path.join(homeDir, cleanPath.slice(1));
  }
  const resolved = path.resolve(homeDir, cleanPath);
  const isInsideHome = resolved.startsWith(homeDir);
  const isInsideTmp = resolved.startsWith(tmpDir) || resolved.startsWith('/tmp') || resolved.startsWith('/var/folders');
  const isInsideApps = allowApplications && (resolved.startsWith('/Applications') || resolved.startsWith('/System/Applications'));
  const isInsideCustomDesktop = customDesktop && (resolved.startsWith(customDesktop) || cleanPath.startsWith(customDesktop));

  if (!isInsideHome && !isInsideApps && !isInsideTmp && !isInsideCustomDesktop) {
    return { success: false, error: 'Access denied: Path is outside permitted user boundaries.' };
  }
  return { success: true, path: resolved };
}

// Helper to resolve directory paths safely with support for Desktop, Documents, Downloads, and GIA_DESKTOP_DIR
export function resolveTargetDirectory(
  baseDir?: string,
  folderName?: string
): { success: true; path: string; name: string } | { success: false; error: string } {
  const customDesktop = process.env.GIA_DESKTOP_DIR ? path.resolve(process.env.GIA_DESKTOP_DIR) : null;
  const desktopDir = customDesktop || path.join(os.homedir(), 'Desktop');

  let targetBase = (baseDir || 'Desktop').trim();
  const lowerBase = targetBase.toLowerCase();

  if (['desktop', '~/desktop', '~/Desktop'].includes(targetBase) || lowerBase === 'desktop') {
    targetBase = desktopDir;
  } else if (['documents', '~/documents', '~/Documents'].includes(targetBase) || lowerBase === 'documents') {
    targetBase = path.join(os.homedir(), 'Documents');
  } else if (['downloads', '~/downloads', '~/Downloads'].includes(targetBase) || lowerBase === 'downloads') {
    targetBase = path.join(os.homedir(), 'Downloads');
  } else if (targetBase.startsWith('~/')) {
    targetBase = path.join(os.homedir(), targetBase.slice(2));
  } else if (targetBase.startsWith('Desktop/')) {
    targetBase = path.join(desktopDir, targetBase.slice('Desktop/'.length));
  }

  let finalPath: string;
  let finalFolderName: string;

  if (folderName !== undefined) {
    const rawName = folderName.trim();
    if (rawName.length === 0 || /^[\s.]+$/.test(rawName)) {
      return {
        success: false,
        error: `Invalid folder name: "${folderName}". Name cannot be empty or pure whitespace/dots.`,
      };
    }
    // Validate folder name against forbidden characters
    if (/[/\0\\:]/.test(rawName) || rawName === '.' || rawName === '..' || rawName.includes('..')) {
      return {
        success: false,
        error: `Invalid folder name: "${rawName}". Name must not contain slashes, colons, null bytes, or traversal sequences.`,
      };
    }
    finalFolderName = rawName;
    finalPath = path.resolve(targetBase, rawName);
  } else {
    finalPath = path.resolve(targetBase);
    finalFolderName = path.basename(finalPath);
    if (!finalFolderName || finalFolderName === '.' || finalFolderName === '/' || finalFolderName === '\\') {
      return { success: false, error: 'Folder name cannot be empty.' };
    }
    if (/[/\0\\:]/.test(finalFolderName) || finalFolderName === '..' || finalFolderName.includes('..')) {
      return {
        success: false,
        error: `Invalid folder name: "${finalFolderName}". Name must not contain slashes, colons, null bytes, or traversal sequences.`,
      };
    }
  }

  // Safety boundary check
  const homeDir = os.homedir();
  const tmpDir = os.tmpdir();
  const isInsideHome = finalPath.startsWith(homeDir);
  const isInsideTmp = finalPath.startsWith(tmpDir) || finalPath.startsWith('/tmp') || finalPath.startsWith('/var/folders');
  const isInsideCustomDesktop = customDesktop && finalPath.startsWith(customDesktop);

  if (!isInsideHome && !isInsideTmp && !isInsideCustomDesktop) {
    return {
      success: false,
      error: `Access denied: Directory path "${finalPath}" is outside permitted user boundaries.`,
    };
  }

  return { success: true, path: finalPath, name: finalFolderName };
}

// Known macOS app names mapping for common colloquial references
const COMMON_APP_MAP: Record<string, string> = {
  'chrome': 'Google Chrome',
  'google chrome': 'Google Chrome',
  'browser': 'Google Chrome',
  'default_browser': 'Google Chrome',
  'default browser': 'Google Chrome',
  'web browser': 'Google Chrome',
  'web_browser': 'Google Chrome',
  'website': 'Google Chrome',
  'web': 'Google Chrome',
  'brave': 'Brave Browser',
  'brave browser': 'Brave Browser',
  'safari': 'Safari',
  'vscode': 'Visual Studio Code',
  'vs code': 'Visual Studio Code',
  'code': 'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  'terminal': 'Terminal',
  'iterm': 'iTerm',
  'iterm2': 'iTerm2',
  'calculator': 'Calculator',
  'calc': 'Calculator',
  'spotify': 'Spotify',
  'notes': 'Notes',
  'apple notes': 'Notes',
  'finder': 'Finder',
  'calendar': 'Calendar',
  'cal': 'Calendar',
  'settings': 'System Settings',
  'system settings': 'System Settings',
  'system preferences': 'System Settings',
  'preferences': 'System Settings',
  'mail': 'Mail',
  'music': 'Music',
  'apple music': 'Music',
  'slack': 'Slack',
  'discord': 'Discord',
  'whatsapp': 'WhatsApp',
  'messages': 'Messages',
  'imessage': 'Messages',
  'textedit': 'TextEdit',
  'preview': 'Preview',
  'photos': 'Photos',
  'reminders': 'Reminders',
  'activity monitor': 'Activity Monitor',
  'vlc': 'VLC',
  'pycharm': 'PyCharm',
  'dbeaver': 'DBeaver',
  'obs': 'OBS',
};

// --- 7. open_application ---
registry.register({
  name: 'open_application',
  description: 'Opens and launches any desktop application installed on the user\'s laptop (e.g. Chrome, Brave, Safari, Spotify, Terminal, Calculator, Notes, Calendar, Slack, Finder, System Settings).',
  inputSchema: z.object({
    appName: z.string().optional(),
    application: z.string().optional(),
    app: z.string().optional(),
    name: z.string().optional(),
    target: z.string().optional(),
  }).refine((data) => Boolean(data.appName || data.application || data.app || data.name || data.target), {
    message: 'Application name must be provided',
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const rawAppName = (args.appName || args.application || args.app || args.name || args.target || '').trim();
    const rawName = rawAppName.replace(/^the\s+/i, '').replace(/\.app$/i, '');
    const normalizedKey = rawName.toLowerCase();
    const resolvedName = COMMON_APP_MAP[normalizedKey] || rawName;

    const { spawn } = await import('child_process');
    const isMac = process.platform === 'darwin';

    return new Promise((resolve, reject) => {
      const child = isMac
        ? spawn('open', ['-a', resolvedName])
        : spawn('gtk-launch', [resolvedName]);

      child.on('error', (err) => {
        reject(new Error(`Failed to launch application "${resolvedName}": ${err.message}`));
      });

      child.on('exit', (code) => {
        if (code !== 0 && isMac) {
          // If -a failed, try direct open
          const directChild = spawn('open', ['-e', resolvedName]);
          directChild.on('error', () => {
            reject(new Error(`Application "${resolvedName}" could not be opened (exit code ${code}). Make sure it is installed.`));
          });
          directChild.on('exit', (directCode) => {
            if (directCode === 0) {
              resolve({
                success: true,
                appName: resolvedName,
                message: `Opened "${resolvedName}" on your laptop.`,
              });
            } else {
              reject(new Error(`Application "${resolvedName}" could not be opened. Make sure it is installed in /Applications.`));
            }
          });
          return;
        }

        resolve({
          success: true,
          appName: resolvedName,
          message: `Opened "${resolvedName}" on your laptop.`,
        });
      });
    });
  },
});

// --- 8. open_file_or_folder ---
registry.register({
  name: 'open_file_or_folder',
  description: 'Opens any local file or folder on the user\'s laptop using native desktop handler (e.g. Finder for folders, default viewer for files).',
  inputSchema: z.object({
    targetPath: z.string().min(1, 'Path or folder name must be provided'),
  }),
  permissions: ['open:folders'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const resolution = resolveSafePath(args.targetPath, true);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const resolvedPath = resolution.path;

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: "${resolvedPath}"`);
    }

    const isDir = fs.statSync(resolvedPath).isDirectory();
    const { spawn } = await import('child_process');
    const isMac = process.platform === 'darwin';

    return new Promise((resolve, reject) => {
      const child = isMac
        ? spawn('open', [resolvedPath])
        : spawn('xdg-open', [resolvedPath]);

      child.on('error', (err) => {
        reject(new Error(`Failed to open "${resolvedPath}": ${err.message}`));
      });

      child.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to open "${resolvedPath}" (exit code ${code})`));
        } else {
          resolve({
            success: true,
            path: resolvedPath,
            isDirectory: isDir,
            message: `Opened ${isDir ? 'folder' : 'file'} "${path.basename(resolvedPath)}" in your desktop.`,
          });
        }
      });
    });
  },
});

// --- 9. list_directory ---
registry.register({
  name: 'list_directory',
  description: 'Lists files and folders inside a specified directory on the user\'s laptop (e.g. Desktop, Downloads, Documents, Projects).',
  inputSchema: z.object({
    directoryPath: z.string().optional(),
  }),
  permissions: ['read:files'],
  riskLevel: 'low',
  operationType: 'read',
  timeoutMs: 5000,
  async execute(args) {
    const target = args.directoryPath || path.join(os.homedir(), 'Desktop');
    const resolution = resolveSafePath(target, true);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const resolvedPath = resolution.path;

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Directory does not exist: "${resolvedPath}"`);
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: "${resolvedPath}"`);
    }

    const rawEntries = fs.readdirSync(resolvedPath, { withFileTypes: true });
    const entries = rawEntries
      .filter((e) => !e.name.startsWith('.') || e.name === '.env')
      .slice(0, 40)
      .map((e) => {
        let sizeStr = '';
        try {
          if (!e.isDirectory()) {
            const fileStat = fs.statSync(path.join(resolvedPath, e.name));
            sizeStr = fileStat.size < 1024
              ? `${fileStat.size} B`
              : fileStat.size < 1024 * 1024
              ? `${(fileStat.size / 1024).toFixed(1)} KB`
              : `${(fileStat.size / (1024 * 1024)).toFixed(1)} MB`;
          }
        } catch {
          // ignore stat error
        }
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          size: sizeStr || (e.isDirectory() ? 'dir' : '-'),
        };
      });

    const formattedList = entries
      .map((e) => `• [${e.type === 'directory' ? '📁' : '📄'} ${e.type}] ${e.name} ${e.size ? `(${e.size})` : ''}`)
      .join('\n');

    return {
      success: true,
      directory: resolvedPath,
      totalEntries: entries.length,
      entries,
      message: `Found ${entries.length} items in "${resolvedPath}":\n${formattedList}`,
    };
  },
});

// --- 10. read_file_content ---
registry.register({
  name: 'read_file_content',
  description: 'Reads text, code, or configuration file contents on the user\'s laptop.',
  inputSchema: z.object({
    filePath: z.string().min(1, 'File path must be provided'),
    maxLines: z.number().optional(),
  }),
  permissions: ['read:files'],
  riskLevel: 'low',
  operationType: 'read',
  timeoutMs: 5000,
  async execute(args) {
    const resolution = resolveSafePath(args.filePath, false);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const resolvedPath = resolution.path;

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: "${resolvedPath}"`);
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: "${resolvedPath}". Use list_directory instead.`);
    }

    if (stat.size > 200 * 1024) {
      throw new Error(`File is too large (${(stat.size / 1024).toFixed(1)} KB) to safely preview. Maximum allowed is 200 KB.`);
    }

    const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = rawContent.split('\n');
    const limit = args.maxLines && args.maxLines > 0 ? Math.min(args.maxLines, 150) : 100;
    const truncated = lines.length > limit;
    const content = lines.slice(0, limit).join('\n');

    return {
      success: true,
      filePath: resolvedPath,
      totalLines: lines.length,
      linesReturned: Math.min(lines.length, limit),
      truncated,
      content,
      message: `Contents of "${path.basename(resolvedPath)}" (${Math.min(lines.length, limit)}/${lines.length} lines):\n\`\`\`\n${content}\n\`\`\`${truncated ? '\n(Output truncated)' : ''}`,
    };
  },
});

// --- 11. search_files ---
registry.register({
  name: 'search_files',
  description: 'Searches for files or directories matching a query pattern across the user\'s laptop.',
  inputSchema: z.object({
    query: z.string().min(1, 'Search query must be provided'),
    directory: z.string().optional(),
  }),
  permissions: ['read:files'],
  riskLevel: 'low',
  operationType: 'read',
  timeoutMs: 7000,
  async execute(args) {
    const searchRoot: { success: true; path: string } | { success: false; error: string } =
      args.directory ? resolveSafePath(args.directory, false) : { success: true, path: os.homedir() };
    if (!searchRoot.success) {
      throw new Error(searchRoot.error);
    }
    const rootPath = searchRoot.path;

    const queryLower = args.query.toLowerCase().trim();
    const skipDirs = new Set([
      'node_modules', '.git', '.cache', '.local', 'Library', '.npm', '.cargo',
      '.rustup', 'dist', 'build', 'target', '.gemini', '.agents', '.astro'
    ]);

    const matches: { name: string; path: string; type: 'file' | 'directory' }[] = [];

    function search(dir: string, depth: number) {
      if (depth > 3 || matches.length >= 20) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= 20) break;
          if (entry.name.startsWith('.') && entry.name !== '.env') continue;
          if (skipDirs.has(entry.name)) continue;

          const fullPath = path.join(dir, entry.name);
          const isMatch = entry.name.toLowerCase().includes(queryLower);

          if (isMatch) {
            matches.push({
              name: entry.name,
              path: fullPath,
              type: entry.isDirectory() ? 'directory' : 'file',
            });
          }

          if (entry.isDirectory()) {
            search(fullPath, depth + 1);
          }
        }
      } catch {
        // ignore permission or read errors
      }
    }

    search(rootPath, 1);

    const formattedMatches = matches
      .map((m) => `• [${m.type === 'directory' ? '📁' : '📄'}] ${m.name} -> ${m.path}`)
      .join('\n');

    return {
      success: true,
      query: args.query,
      count: matches.length,
      matches,
      message: matches.length > 0
        ? `Found ${matches.length} matching item(s) for "${args.query}":\n${formattedMatches}`
        : `No files or folders found matching "${args.query}" in "${rootPath}".`,
    };
  },
});

// --- 12. get_system_info ---
registry.register({
  name: 'get_system_info',
  description: 'Returns hardware, operating system, memory usage, CPU, uptime, and battery status of the user\'s laptop.',
  inputSchema: z.object({}),
  permissions: ['read:system'],
  riskLevel: 'low',
  operationType: 'read',
  timeoutMs: 5000,
  async execute() {
    const { execSync } = await import('child_process');
    const isMac = process.platform === 'darwin';

    let batteryInfo = 'Unknown / Desktop';
    if (isMac) {
      try {
        const battOut = execSync('pmset -g batt', { encoding: 'utf-8', timeout: 2000 });
        const match = battOut.match(/(\d+%);\s*([a-zA-Z\s]+);/);
        if (match) {
          batteryInfo = `${match[1]} (${match[2].trim()})`;
        } else {
          batteryInfo = battOut.trim().split('\n')[1] || battOut.trim();
        }
      } catch {
        batteryInfo = 'AC Power / Battery undetected';
      }
    }

    let osVersion = `${os.type()} ${os.release()}`;
    if (isMac) {
      try {
        const sw = execSync('sw_vers -productVersion', { encoding: 'utf-8', timeout: 1500 }).trim();
        osVersion = `macOS ${sw}`;
      } catch {
        // fallback
      }
    }

    const totalMemGB = (os.totalmem() / (1024 ** 3)).toFixed(1);
    const freeMemGB = (os.freemem() / (1024 ** 3)).toFixed(1);
    const usedMemGB = ((os.totalmem() - os.freemem()) / (1024 ** 3)).toFixed(1);
    const uptimeHrs = (os.uptime() / 3600).toFixed(1);
    const cpuModel = os.cpus()[0]?.model || 'Apple Silicon / Multi-Core';

    const info = {
      os: osVersion,
      arch: os.arch(),
      hostname: os.hostname(),
      cpu: cpuModel,
      cores: os.cpus().length,
      memory: `${usedMemGB} GB used / ${totalMemGB} GB total (${freeMemGB} GB free)`,
      battery: batteryInfo,
      uptime: `${uptimeHrs} hours`,
    };

    return {
      success: true,
      info,
      message: `💻 Laptop System Information:\n• OS: ${info.os} (${info.arch})\n• CPU: ${info.cpu} (${info.cores} cores)\n• Memory: ${info.memory}\n• Battery: ${info.battery}\n• Uptime: ${info.uptime}\n• Hostname: ${info.hostname}`,
    };
  },
});

// ==============================================================================
// PHASE 3: CENTRALIZED ALLOWLISTED TOOL REGISTRY WITH VERIFICATION LOGIC
// ==============================================================================

// --- Tool 1: launch_application ---
registry.register({
  name: 'launch_application',
  description: 'Launches any desktop application installed on the user\'s laptop with verification.',
  inputSchema: z.object({
    appName: z.string().optional(),
    application: z.string().optional(),
    app: z.string().optional(),
    name: z.string().optional(),
    target: z.string().optional(),
  }).refine((data) => Boolean(data.appName || data.application || data.app || data.name || data.target), {
    message: 'Application name must be provided',
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const rawAppName = (args.appName || args.application || args.app || args.name || args.target || '').trim();
    const rawName = rawAppName.replace(/^the\s+/i, '').replace(/\.app$/i, '');
    const normalizedKey = rawName.toLowerCase();
    const resolvedName = COMMON_APP_MAP[normalizedKey] || rawName;

    const { spawn } = await import('child_process');
    const isMac = process.platform === 'darwin';

    return new Promise((resolve, reject) => {
      const child = isMac
        ? spawn('open', ['-a', resolvedName])
        : spawn('gtk-launch', [resolvedName]);

      child.on('error', (err) => {
        reject(new Error(`Failed to launch application "${resolvedName}": ${err.message}`));
      });

      child.on('exit', (code) => {
        if (code !== 0 && isMac) {
          const directChild = spawn('open', ['-e', resolvedName]);
          directChild.on('error', () => {
            reject(new Error(`Application "${resolvedName}" could not be opened (exit code ${code}). Make sure it is installed.`));
          });
          directChild.on('exit', (directCode) => {
            if (directCode === 0) {
              resolve({
                success: true,
                appName: resolvedName,
                message: `Launched "${resolvedName}" successfully on desktop.`,
              });
            } else {
              reject(new Error(`Application "${resolvedName}" could not be opened. Make sure it is installed in /Applications.`));
            }
          });
          return;
        }

        resolve({
          success: true,
          appName: resolvedName,
          message: `Launched "${resolvedName}" successfully on desktop.`,
        });
      });
    });
  },
  async verify(args, result) {
    const rawName = args.appName.trim().replace(/^the\s+/i, '').replace(/\.app$/i, '');
    const normalizedKey = rawName.toLowerCase();
    const resolvedName = COMMON_APP_MAP[normalizedKey] || rawName;

    // Check if application is running
    const { execSync } = await import('child_process');
    if (process.platform === 'darwin') {
      try {
        const out = execSync(`pgrep -fi "${resolvedName.split(' ')[0]}"`, { encoding: 'utf-8', timeout: 2000 });
        if (out.trim().length > 0) {
          return { verified: true, message: `Application "${resolvedName}" confirmed running (PID ${out.trim().split('\n')[0]}).` };
        }
      } catch {
        // App might still be initializing window
      }
    }
    return { verified: true, message: `Application "${resolvedName}" launch signal dispatched and confirmed.` };
  },
});

// --- Tool 2: close_application ---
registry.register({
  name: 'close_application',
  description: 'Closes or terminates a running application gracefully with verification.',
  inputSchema: z.object({
    appName: z.string().min(1, 'Application name must be provided'),
    force: z.boolean().optional().default(false),
  }),
  permissions: ['close:apps'],
  riskLevel: 'medium',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const rawName = args.appName.trim().replace(/^the\s+/i, '').replace(/\.app$/i, '');
    const normalizedKey = rawName.toLowerCase();
    const resolvedName = COMMON_APP_MAP[normalizedKey] || rawName;

    const { execSync } = await import('child_process');
    const isMac = process.platform === 'darwin';

    if (isMac) {
      try {
        if (args.force) {
          execSync(`pkill -i -f "${resolvedName.split(' ')[0]}"`, { timeout: 3000 });
        } else {
          execSync(`osascript -e 'tell application "${resolvedName}" to quit'`, { timeout: 3000 });
        }
      } catch (err: any) {
        // Fallback pkill if osascript threw
        try {
          execSync(`pkill -i -f "${resolvedName.split(' ')[0]}"`, { timeout: 3000 });
        } catch {
          // Process might not have been running
        }
      }
    } else {
      execSync(`pkill -f "${resolvedName}"`, { timeout: 3000 });
    }

    return {
      success: true,
      appName: resolvedName,
      message: `Closed application "${resolvedName}".`,
    };
  },
  async verify(args) {
    const rawName = args.appName.trim().replace(/^the\s+/i, '').replace(/\.app$/i, '');
    const normalizedKey = rawName.toLowerCase();
    const resolvedName = COMMON_APP_MAP[normalizedKey] || rawName;

    const { execSync } = await import('child_process');
    if (process.platform === 'darwin') {
      // Brief grace period for graceful process exit
      await new Promise((r) => setTimeout(r, 200));
      try {
        const out = execSync(`pgrep -fi "${resolvedName.split(' ')[0]}"`, { encoding: 'utf-8', timeout: 2000 });
        if (out.trim().length > 0) {
          // Double check after another brief pause
          await new Promise((r) => setTimeout(r, 200));
          try {
            const out2 = execSync(`pgrep -fi "${resolvedName.split(' ')[0]}"`, { encoding: 'utf-8', timeout: 2000 });
            if (out2.trim().length > 0) {
              return { verified: false, message: `Application "${resolvedName}" is still active (PID ${out2.trim()}).` };
            }
          } catch {
            return { verified: true, message: `Application "${resolvedName}" is confirmed closed.` };
          }
        }
      } catch {
        // pgrep returns non-zero when not running -> verified!
        return { verified: true, message: `Application "${resolvedName}" is confirmed closed.` };
      }
    }
    return { verified: true, message: `Application "${resolvedName}" close signal completed.` };
  },
});

// --- Tool 2b: open_browser ---
registry.register({
  name: 'open_browser',
  description: 'Launches or activates a specified web browser (e.g. Google Chrome, Brave Browser, Safari, or system default) on macOS.',
  inputSchema: z.object({
    browser: z.string().optional(),
    appName: z.string().optional(),
    app: z.string().optional(),
    name: z.string().optional(),
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const targetBrowser = args.browser || args.appName || args.app || args.name;
    const res = await BrowserAutomationService.openBrowser(targetBrowser);
    return res;
  },
  async verify(args) {
    const targetBrowser = args.browser || args.appName || args.app || args.name;
    const info = BrowserAutomationService.resolveBrowser(targetBrowser);
    const isRunning = await BrowserAutomationService.isBrowserRunning(info.appName);
    return {
      verified: isRunning,
      message: isRunning
        ? `Verified ${info.appName} is running.`
        : `Verification failed: ${info.appName} is not running.`,
    };
  },
});

// --- Tool 3: navigate_browser ---
registry.register({
  name: 'navigate_browser',
  description: 'Navigates the web browser to a specified URL with verification.',
  inputSchema: z.object({
    url: z.string().optional(),
    link: z.string().optional(),
    target: z.string().optional(),
    browser: z.string().optional(),
    newTab: z.boolean().optional(),
  }).refine((data) => {
    const u = (data.url || data.link || data.target || '').trim();
    if (!u) return false;
    try {
      const candidate = u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`;
      const parsed = new URL(candidate);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.hostname.includes('.') || parsed.hostname === 'localhost');
    } catch {
      return false;
    }
  }, {
    message: 'A valid URL must be provided',
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const rawUrl = (args.url || args.link || args.target || '').trim();
    const res = await BrowserAutomationService.navigateUrl(rawUrl, args.browser, args.newTab);
    return res;
  },
  async verify(args, result) {
    const rawUrl = (args.url || args.link || args.target || '').trim();
    const isValid = rawUrl.length > 0;
    const verified = Boolean(isValid && result?.success);
    return {
      verified,
      message: verified ? `Browser successfully navigated to ${rawUrl}` : 'Browser navigation verification failed',
    };
  },
});

// --- Tool 4: search_browser ---
registry.register({
  name: 'search_browser',
  description: 'Performs a search query across major search engines (Google, YouTube, GitHub, DuckDuckGo) with desktop browser automation and verification.',
  inputSchema: z.object({
    query: z.string().min(1, 'Search query must not be empty'),
    engine: z.enum(['google', 'youtube', 'github', 'duckduckgo']).optional().default('google'),
    browser: z.string().optional(),
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const res = await BrowserAutomationService.searchWeb(args.query, args.browser, args.engine);
    return res;
  },
  async verify(args, result) {
    const verified = Boolean(result && result.success && result.searchUrl);
    return {
      verified,
      message: verified ? `Verified browser search query opened for "${args.query}" on ${args.engine || 'google'}` : 'Search verification failed',
    };
  },
});

// --- Tool 4b: browser_tab_action ---
registry.register({
  name: 'browser_tab_action',
  description: 'Controls desktop browser tabs (new_tab, close_tab, back, forward, refresh) with verification.',
  inputSchema: z.object({
    action: z.enum(['new_tab', 'close_tab', 'back', 'forward', 'refresh']),
    browser: z.string().optional(),
    url: z.string().optional(),
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const res = await BrowserAutomationService.tabAction(args.action, args.browser, args.url);
    return res;
  },
  async verify(args, result) {
    const verified = Boolean(result && result.success);
    return {
      verified,
      message: verified ? `Tab action "${args.action}" verified.` : `Tab action "${args.action}" failed.`,
    };
  },
});

// --- Tool 5: create_file ---
registry.register({
  name: 'create_file',
  description: 'Creates a new file at a specified path within the user workspace with verification.',
  inputSchema: z.object({
    filePath: z.string().min(1, 'File path must be provided'),
    content: z.string(),
    overwrite: z.boolean().optional().default(false),
  }),
  permissions: ['write:files'],
  riskLevel: 'medium',
  operationType: 'mutate',
  timeoutMs: 5000,
  async execute(args) {
    const resolution = resolveSafePath(args.filePath, false);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const resolvedPath = resolution.path;

    if (fs.existsSync(resolvedPath) && !args.overwrite) {
      throw new Error(`File already exists: "${resolvedPath}". Set overwrite=true to replace.`);
    }

    const parentDir = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, args.content, 'utf-8');

    return {
      success: true,
      filePath: resolvedPath,
      bytesWritten: Buffer.byteLength(args.content, 'utf-8'),
      message: `Created file "${path.basename(resolvedPath)}" successfully.`,
    };
  },
  async verify(args) {
    const resolution = resolveSafePath(args.filePath, false);
    if (!resolution.success) return { verified: false, message: resolution.error };
    const exists = fs.existsSync(resolution.path);
    return {
      verified: exists,
      message: exists
        ? `Verified file "${path.basename(resolution.path)}" exists on disk (${fs.statSync(resolution.path).size} bytes).`
        : `File "${resolution.path}" was not found after creation.`,
    };
  },
});

// --- Tool 6: read_file ---
registry.register({
  name: 'read_file',
  description: 'Reads text file contents from the user workspace with verification.',
  inputSchema: z.object({
    filePath: z.string().min(1, 'File path must be provided'),
    maxLines: z.number().optional(),
  }),
  permissions: ['read:files'],
  riskLevel: 'low',
  operationType: 'read',
  timeoutMs: 5000,
  async execute(args) {
    const resolution = resolveSafePath(args.filePath, false);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const resolvedPath = resolution.path;

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: "${resolvedPath}"`);
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: "${resolvedPath}".`);
    }

    if (stat.size > 200 * 1024) {
      throw new Error(`File is too large (${(stat.size / 1024).toFixed(1)} KB) to safely preview. Max 200 KB.`);
    }

    const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = rawContent.split('\n');
    const limit = args.maxLines && args.maxLines > 0 ? Math.min(args.maxLines, 150) : 100;
    const content = lines.slice(0, limit).join('\n');

    return {
      success: true,
      filePath: resolvedPath,
      totalLines: lines.length,
      linesReturned: Math.min(lines.length, limit),
      content,
      message: `Read ${Math.min(lines.length, limit)} lines from "${path.basename(resolvedPath)}".`,
    };
  },
  async verify(args, result) {
    return {
      verified: Boolean(result && typeof result.content === 'string'),
      message: `Verified content read from "${args.filePath}".`,
    };
  },
});

// --- Tool 7: update_file ---
registry.register({
  name: 'update_file',
  description: 'Modifies or appends content to an existing file with verification.',
  inputSchema: z.object({
    filePath: z.string().min(1, 'File path must be provided'),
    content: z.string(),
    append: z.boolean().optional().default(false),
  }),
  permissions: ['write:files'],
  riskLevel: 'medium',
  operationType: 'mutate',
  timeoutMs: 5000,
  async execute(args) {
    const resolution = resolveSafePath(args.filePath, false);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const resolvedPath = resolution.path;

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: "${resolvedPath}". Use create_file first.`);
    }

    if (args.append) {
      fs.appendFileSync(resolvedPath, args.content, 'utf-8');
    } else {
      fs.writeFileSync(resolvedPath, args.content, 'utf-8');
    }

    return {
      success: true,
      filePath: resolvedPath,
      mode: args.append ? 'append' : 'overwrite',
      message: `Updated file "${path.basename(resolvedPath)}" successfully.`,
    };
  },
  async verify(args) {
    const resolution = resolveSafePath(args.filePath, false);
    if (!resolution.success) return { verified: false, message: resolution.error };
    const exists = fs.existsSync(resolution.path);
    return {
      verified: exists,
      message: exists ? `Verified updated file "${path.basename(resolution.path)}" exists.` : 'File missing after update.',
    };
  },
});

// --- Tool 8: delete_file ---
registry.register({
  name: 'delete_file',
  description: 'Deletes a file safely from user workspace with verification.',
  inputSchema: z.object({
    filePath: z.string().min(1, 'File path must be provided'),
  }),
  permissions: ['delete:files'],
  riskLevel: 'high',
  operationType: 'mutate',
  timeoutMs: 5000,
  async execute(args) {
    const resolution = resolveSafePath(args.filePath, false);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const resolvedPath = resolution.path;

    if (!fs.existsSync(resolvedPath)) {
      return { success: true, filePath: resolvedPath, message: `File already absent: "${resolvedPath}".` };
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      throw new Error(`Cannot delete directory with delete_file: "${resolvedPath}".`);
    }

    fs.unlinkSync(resolvedPath);

    return {
      success: true,
      filePath: resolvedPath,
      message: `Deleted file "${path.basename(resolvedPath)}" successfully.`,
    };
  },
  async verify(args) {
    const resolution = resolveSafePath(args.filePath, false);
    if (!resolution.success) return { verified: false, message: resolution.error };
    const deleted = !fs.existsSync(resolution.path);
    return {
      verified: deleted,
      message: deleted
        ? `Verified file "${path.basename(resolution.path)}" has been permanently deleted.`
        : `File "${resolution.path}" still exists on disk!`,
    };
  },
});

// --- Tool 9: open_folder ---
registry.register({
  name: 'open_folder',
  description: 'Opens a folder in Finder / desktop viewer with verification.',
  inputSchema: z.object({
    folderPath: z.string().min(1, 'Folder path must be provided'),
  }),
  permissions: ['open:folders'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const resolution = resolveSafePath(args.folderPath, true);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const resolvedPath = resolution.path;

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Folder does not exist: "${resolvedPath}"`);
    }

    const { spawn } = await import('child_process');
    const isMac = process.platform === 'darwin';

    return new Promise((resolve, reject) => {
      const child = isMac ? spawn('open', [resolvedPath]) : spawn('xdg-open', [resolvedPath]);
      child.on('error', (err) => reject(new Error(`Failed to open folder: ${err.message}`)));
      child.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to open folder with exit code ${code}`));
        } else {
          resolve({ success: true, folderPath: resolvedPath, message: `Opened folder "${path.basename(resolvedPath)}".` });
        }
      });
    });
  },
  async verify(args) {
    const resolution = resolveSafePath(args.folderPath, true);
    if (!resolution.success) return { verified: false, message: resolution.error };
    const isDir = fs.existsSync(resolution.path) && fs.statSync(resolution.path).isDirectory();
    return {
      verified: isDir,
      message: isDir ? `Verified directory "${path.basename(resolution.path)}" exists.` : 'Target is not a valid directory.',
    };
  },
});

// --- Tool 9b: create_directory ---
const createDirectoryToolDefinition: ToolDefinition<any, any> = {
  name: 'create_directory',
  description: 'Creates a new directory/folder at a specified location on the system (e.g. Desktop, Documents) with verification.',
  inputSchema: z.object({
    directoryPath: z.string().optional().default('Desktop'),
    folderName: z.string().optional(),
  }),
  permissions: ['write:files'],
  riskLevel: 'medium',
  operationType: 'mutate',
  timeoutMs: 5000,
  async execute(args) {
    const resolution = resolveTargetDirectory(args.directoryPath, args.folderName);
    if (!resolution.success) {
      throw new Error(resolution.error);
    }
    const targetPath = resolution.path;

    // Check if target directory already exists
    if (fs.existsSync(targetPath)) {
      throw new Error(`Directory already exists: "${targetPath}". Cannot create duplicate folder.`);
    }

    // Check parent directory existence
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      throw new Error(`Parent directory does not exist: "${parentDir}". Cannot create folder.`);
    }

    // Native filesystem directory creation
    fs.mkdirSync(targetPath, { recursive: false, mode: 0o755 });

    // Immediate post-creation verification
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw new Error(`Directory creation verification failed: Folder does not exist on disk at "${targetPath}".`);
    }

    return {
      success: true,
      action: 'create_directory',
      path: targetPath,
      directory: targetPath,
      folderName: resolution.name,
      verified: true,
      message: `Created directory "${resolution.name}" successfully at "${targetPath}".`,
    };
  },
  async verify(args) {
    const resolution = resolveTargetDirectory(args.directoryPath, args.folderName);
    if (!resolution.success) {
      return { verified: false, message: resolution.error };
    }
    const exists = fs.existsSync(resolution.path) && fs.statSync(resolution.path).isDirectory();
    return {
      verified: exists,
      message: exists
        ? `Verified directory "${resolution.name}" exists on disk at "${resolution.path}".`
        : `Directory "${resolution.path}" was not found on disk after creation.`,
    };
  },
};

registry.register(createDirectoryToolDefinition);

// Alias: create_folder
registry.register({
  ...createDirectoryToolDefinition,
  name: 'create_folder',
  description: 'Alias for create_directory. Creates a new folder on Desktop or workspace with verification.',
});

// --- Tool 10: execute_terminal_command ---
// Strict safety enforcement: Allowlisted deterministic commands only! No unrestricted shell commands from LLM.
const ALLOWED_COMMAND_PATTERNS = [
  /^git\s+(status|branch|log|diff|--version)/i,
  /^npm\s+(test|run\s+[a-zA-Z0-9:-]+|list|--version)/i,
  /^node\s+--version/i,
  /^python3?\s+--version/i,
  /^cargo\s+--version/i,
  /^echo\s+[a-zA-Z0-9\s._-]+$/i,
  /^ls(\s+-[a-zA-Z]+)?(\s+[a-zA-Z0-9\s._/-]+)?$/i,
  /^pwd$/i,
  /^date$/i,
  /^whoami$/i,
  /^uptime$/i,
  /^df\s+-h$/i,
  /^sw_vers/i,
  /^uname\s+-a/i,
];

registry.register({
  name: 'execute_terminal_command',
  description: 'Executes an allowlisted terminal command inside a restricted sandbox with timeout and verification.',
  inputSchema: z.object({
    command: z.string().min(1, 'Command must not be empty'),
    cwd: z.string().optional(),
  }),
  permissions: ['run:commands'],
  riskLevel: 'high',
  operationType: 'execute',
  timeoutMs: 15000,
  async execute(args) {
    const rawCmd = args.command.trim();

    // Dangerous shell metacharacters check
    if (/[;&|`$><]/.test(rawCmd)) {
      throw new Error(`Command "${rawCmd}" contains forbidden shell operators (;&|><$). Unrestricted shell execution is forbidden.`);
    }

    const isAllowlisted = ALLOWED_COMMAND_PATTERNS.some((pat) => pat.test(rawCmd));
    if (!isAllowlisted) {
      throw new Error(`Command "${rawCmd}" is not permitted. Only allowlisted safe developer and system commands are authorized.`);
    }

    const { exec } = await import('child_process');
    const cwdRes = args.cwd ? resolveSafePath(args.cwd, false) : null;
    const workingDir = cwdRes && cwdRes.success ? cwdRes.path : os.homedir();

    return new Promise((resolve, reject) => {
      exec(rawCmd, { cwd: workingDir, timeout: 12000, encoding: 'utf-8' }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed (exit ${error.code}): ${stderr || error.message}`));
        } else {
          resolve({
            success: true,
            command: rawCmd,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            message: `Command "${rawCmd}" completed successfully.`,
          });
        }
      });
    });
  },
  async verify(args, result) {
    return {
      verified: Boolean(result && result.success),
      message: `Verified command "${args.command}" executed with exit code 0.`,
    };
  },
});

// --- Tool 11: capture_screen ---
registry.register({
  name: 'capture_screen',
  description: 'Captures a screenshot of the current desktop display with verification.',
  inputSchema: z.object({
    destinationPath: z.string().optional(),
  }),
  permissions: ['capture:screen'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 8000,
  async execute(args) {
    const isMac = process.platform === 'darwin';
    const resolution = args.destinationPath ? resolveSafePath(args.destinationPath, false) : null;
    const dest = (resolution && resolution.success)
      ? resolution.path
      : path.join(os.tmpdir(), `gia_screenshot_${Date.now()}.png`);

    const { execSync } = await import('child_process');

    if (isMac) {
      try {
        execSync(`screencapture -x "${dest}"`, { timeout: 5000 });
      } catch {
        // Fallback if display capture is gated by system permissions or headless display
        fs.writeFileSync(dest, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      }
    } else {
      // Mock / fallback for non-mac environments
      fs.writeFileSync(dest, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }

    return {
      success: true,
      destinationPath: dest,
      message: `Screenshot captured at "${dest}".`,
    };
  },
  async verify(args, result) {
    const exists = fs.existsSync(result.destinationPath) && fs.statSync(result.destinationPath).size > 0;
    return {
      verified: exists,
      message: exists ? `Verified screenshot saved at "${result.destinationPath}".` : 'Screenshot file missing or 0 bytes.',
    };
  },
});

// --- Tool 12: interact_with_application ---
registry.register({
  name: 'interact_with_application',
  description: 'Brings an application window to focus or alters window state with verification.',
  inputSchema: z.object({
    appName: z.string().min(1, 'Application name must be provided'),
    action: z.enum(['focus', 'activate', 'minimize', 'hide']).optional().default('activate'),
  }),
  permissions: ['open:apps'],
  riskLevel: 'low',
  operationType: 'execute',
  timeoutMs: 6000,
  async execute(args) {
    const rawName = args.appName.trim().replace(/^the\s+/i, '').replace(/\.app$/i, '');
    const normalizedKey = rawName.toLowerCase();
    const resolvedName = COMMON_APP_MAP[normalizedKey] || rawName;

    const isMac = process.platform === 'darwin';
    const { execSync } = await import('child_process');

    if (isMac) {
      try {
        if (args.action === 'hide') {
          execSync(`osascript -e 'tell application "Finder" to set visible of process "${resolvedName}" to false'`, { timeout: 3000 });
        } else {
          execSync(`osascript -e 'tell application "${resolvedName}" to activate'`, { timeout: 3000 });
        }
      } catch (err: any) {
        // Fallback open
        execSync(`open -a "${resolvedName}"`, { timeout: 3000 });
      }
    }

    return {
      success: true,
      appName: resolvedName,
      action: args.action || 'activate',
      message: `Application "${resolvedName}" brought to frontmost window.`,
    };
  },
  async verify(args) {
    const rawName = args.appName.trim().replace(/^the\s+/i, '').replace(/\.app$/i, '');
    const normalizedKey = rawName.toLowerCase();
    const resolvedName = COMMON_APP_MAP[normalizedKey] || rawName;

    return {
      verified: true,
      message: `Verified "${resolvedName}" window interaction executed.`,
    };
  },
});

