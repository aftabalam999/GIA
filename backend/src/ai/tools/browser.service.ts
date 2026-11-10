import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

export interface BrowserInfo {
  appName: string;
  bundleId: string;
  isInstalled: boolean;
}

export type SupportedBrowser = 'chrome' | 'brave' | 'safari' | 'default';

export interface TabActionResult {
  success: boolean;
  action: 'new_tab' | 'close_tab' | 'back' | 'forward' | 'refresh';
  browser: string;
  url?: string;
  message: string;
}

export class BrowserAutomationService {
  private static defaultBrowserCache: { name: string; timestamp: number } | null = null;

  /**
   * Known application mappings on macOS
   */
  private static readonly KNOWN_BROWSERS: Record<string, { appName: string; bundleId: string; paths: string[] }> = {
    chrome: {
      appName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      paths: ['/Applications/Google Chrome.app', `${os.homedir()}/Applications/Google Chrome.app`],
    },
    'google chrome': {
      appName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      paths: ['/Applications/Google Chrome.app', `${os.homedir()}/Applications/Google Chrome.app`],
    },
    brave: {
      appName: 'Brave Browser',
      bundleId: 'com.brave.Browser',
      paths: ['/Applications/Brave Browser.app', `${os.homedir()}/Applications/Brave Browser.app`],
    },
    'brave browser': {
      appName: 'Brave Browser',
      bundleId: 'com.brave.Browser',
      paths: ['/Applications/Brave Browser.app', `${os.homedir()}/Applications/Brave Browser.app`],
    },
    safari: {
      appName: 'Safari',
      bundleId: 'com.apple.Safari',
      paths: ['/Applications/Safari.app', '/System/Cryptexes/App/System/Applications/Safari.app'],
    },
    edge: {
      appName: 'Microsoft Edge',
      bundleId: 'com.microsoft.edgemac',
      paths: ['/Applications/Microsoft Edge.app', `${os.homedir()}/Applications/Microsoft Edge.app`],
    },
    firefox: {
      appName: 'Firefox',
      bundleId: 'org.mozilla.firefox',
      paths: ['/Applications/Firefox.app', `${os.homedir()}/Applications/Firefox.app`],
    },
  };

  /**
   * Determine the system default browser on macOS via LaunchServices.
   */
  public static resolveDefaultBrowser(): string {
    const now = Date.now();
    if (this.defaultBrowserCache && now - this.defaultBrowserCache.timestamp < 30000) {
      return this.defaultBrowserCache.name;
    }

    let defaultName = 'Google Chrome';
    try {
      const stdout = execSync(
        'defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null || true',
        { encoding: 'utf8', timeout: 2000 }
      );
      const httpHandlerMatch = stdout.match(/LSHandlerRoleAll\s*=\s*"([^"]+)";\s*LSHandlerURLScheme\s*=\s*https?;/i);
      const role = httpHandlerMatch ? httpHandlerMatch[1].toLowerCase() : '';

      if (role.includes('brave')) {
        defaultName = 'Brave Browser';
      } else if (role.includes('chrome')) {
        defaultName = 'Google Chrome';
      } else if (role.includes('safari')) {
        defaultName = 'Safari';
      } else if (role.includes('edgemac')) {
        defaultName = 'Microsoft Edge';
      } else if (role.includes('firefox')) {
        defaultName = 'Firefox';
      }
    } catch {
      // fallback
    }

    // Verify the detected browser is actually installed, otherwise fall back to another installed one
    if (!this.isBrowserInstalled(defaultName)) {
      if (this.isBrowserInstalled('Google Chrome')) {
        defaultName = 'Google Chrome';
      } else if (this.isBrowserInstalled('Brave Browser')) {
        defaultName = 'Brave Browser';
      } else if (this.isBrowserInstalled('Safari')) {
        defaultName = 'Safari';
      }
    }

    this.defaultBrowserCache = { name: defaultName, timestamp: now };
    return defaultName;
  }

  /**
   * Check whether a specific browser is installed on macOS.
   */
  public static isBrowserInstalled(browserIdentifier: string): boolean {
    const lower = browserIdentifier.trim().toLowerCase();
    const known = this.KNOWN_BROWSERS[lower];

    // 1. Check known application bundle file paths
    if (known) {
      for (const p of known.paths) {
        if (fs.existsSync(p)) {
          return true;
        }
      }
    }

    // 2. Direct path check if full path provided
    if (browserIdentifier.endsWith('.app') && fs.existsSync(browserIdentifier)) {
      return true;
    }
    const standardAppPath = `/Applications/${browserIdentifier}.app`;
    if (fs.existsSync(standardAppPath)) {
      return true;
    }

    // 3. Check macOS LaunchServices via osascript
    try {
      const appName = known ? known.appName : browserIdentifier;
      const script = `try\n  id of application "${appName}"\n  return "installed"\non error\n  return "not_installed"\nend try`;
      const res = execSync('osascript', { input: script, encoding: 'utf8', timeout: 2500 }).trim();
      return res === 'installed';
    } catch {
      return false;
    }
  }

  /**
   * Resolve browser details. Throws if explicitly requested browser is not installed.
   */
  public static resolveBrowser(requested?: string): BrowserInfo {
    const trimmed = (requested || '').trim();
    const lower = trimmed.toLowerCase();

    // Default / Unspecified browser
    if (
      !trimmed ||
      lower === 'default' ||
      lower === 'default_browser' ||
      lower === 'default browser' ||
      lower === 'browser' ||
      lower === 'web browser' ||
      lower === 'web_browser' ||
      lower === 'the browser' ||
      lower === 'internet'
    ) {
      const defaultName = this.resolveDefaultBrowser();
      const known = this.KNOWN_BROWSERS[defaultName.toLowerCase()] || {
        appName: defaultName,
        bundleId: 'com.google.Chrome',
        paths: [],
      };
      return {
        appName: known.appName,
        bundleId: known.bundleId,
        isInstalled: true,
      };
    }

    // Explicitly requested browser
    const known = this.KNOWN_BROWSERS[lower];
    const appName = known ? known.appName : trimmed;
    const bundleId = known ? known.bundleId : `custom.${lower}`;
    const installed = this.isBrowserInstalled(appName);

    return {
      appName,
      bundleId,
      isInstalled: installed,
    };
  }

  /**
   * Check if a browser process is currently running.
   */
  public static async isBrowserRunning(appName: string): Promise<boolean> {
    try {
      const script = `application "${appName}" is running`;
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 3000 });
      return stdout.trim().toLowerCase() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Launch a desktop browser.
   */
  public static async openBrowser(requestedBrowser?: string): Promise<{
    success: boolean;
    browser: string;
    bundleId: string;
    message: string;
  }> {
    const info = this.resolveBrowser(requestedBrowser);
    if (!info.isInstalled) {
      throw new Error(`Browser "${info.appName}" is not installed on this system.`);
    }

    const isRunning = await this.isBrowserRunning(info.appName);
    if (!isRunning) {
      await execFileAsync('open', ['-a', info.appName], { timeout: 8000 });
      // Short delay for process startup
      await new Promise((res) => setTimeout(res, 500));
    } else {
      // Activate running window
      await execFileAsync('osascript', ['-e', `tell application "${info.appName}" to activate`], { timeout: 3000 });
    }

    const runningAfter = await this.isBrowserRunning(info.appName);
    if (!runningAfter) {
      throw new Error(`Failed to verify running process for browser "${info.appName}".`);
    }

    return {
      success: true,
      browser: info.appName,
      bundleId: info.bundleId,
      message: `Launched ${info.appName} successfully.`,
    };
  }

  /**
   * Normalize and validate URL. Rejects dangerous protocols (javascript:, file:, data:).
   */
  public static validateAndNormalizeUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      throw new Error('A valid URL must be provided.');
    }

    // Reject unsafe / scriptable protocols
    const forbiddenProtocols = /^(javascript|data|file|vbscript|blob|about):/i;
    if (forbiddenProtocols.test(trimmed)) {
      throw new Error(`Invalid or prohibited URL protocol: "${trimmed}". Only HTTP/HTTPS URLs are permitted.`);
    }

    const candidate = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Prohibited protocol "${parsed.protocol}". Only HTTP/HTTPS URLs are permitted.`);
      }
      if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
        throw new Error(`Invalid hostname in destination URL: "${candidate}".`);
      }
      return candidate;
    } catch (err: any) {
      throw new Error(`Malformed URL "${trimmed}": ${err.message}`);
    }
  }

  /**
   * Navigate browser to a URL.
   */
  public static async navigateUrl(
    targetUrl: string,
    requestedBrowser?: string,
    newTab: boolean = false
  ): Promise<{
    success: boolean;
    browser: string;
    url: string;
    newTab: boolean;
    message: string;
  }> {
    const cleanUrl = this.validateAndNormalizeUrl(targetUrl);
    const info = this.resolveBrowser(requestedBrowser);

    if (!info.isInstalled) {
      throw new Error(`Browser "${info.appName}" is not installed on this system.`);
    }

    // Sanitize URL for AppleScript literal
    const sanitizedUrl = cleanUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Chromium browsers (Chrome, Brave, Edge)
    if (
      info.appName === 'Google Chrome' ||
      info.appName === 'Brave Browser' ||
      info.appName === 'Microsoft Edge'
    ) {
      let script: string;
      if (newTab) {
        script = `
tell application "${info.appName}"
  activate
  if (count of windows) = 0 then
    make new window
    set URL of active tab of front window to "${sanitizedUrl}"
  else
    tell front window
      make new tab with properties {URL:"${sanitizedUrl}"}
    end tell
  end if
end tell
return "ok"
`;
      } else {
        script = `
tell application "${info.appName}"
  activate
  if (count of windows) = 0 then
    make new window
    set URL of active tab of front window to "${sanitizedUrl}"
  else
    set URL of active tab of front window to "${sanitizedUrl}"
  end if
end tell
return "ok"
`;
      }

      await execFileAsync('osascript', ['-e', script], { timeout: 8000 });
    } else if (info.appName === 'Safari') {
      const script = `
tell application "Safari"
  activate
  open location "${sanitizedUrl}"
end tell
return "ok"
`;
      await execFileAsync('osascript', ['-e', script], { timeout: 8000 });
    } else {
      // Generic macOS open command
      await execFileAsync('open', ['-a', info.appName, cleanUrl], { timeout: 8000 });
    }

    return {
      success: true,
      browser: info.appName,
      url: cleanUrl,
      newTab,
      message: `Navigated ${info.appName} to ${cleanUrl}${newTab ? ' in a new tab' : ''}.`,
    };
  }

  /**
   * Search query on configured or specified search engine.
   */
  public static async searchWeb(
    query: string,
    requestedBrowser?: string,
    engine: 'google' | 'youtube' | 'github' | 'duckduckgo' = 'google'
  ): Promise<{
    success: boolean;
    browser: string;
    engine: string;
    query: string;
    searchUrl: string;
    message: string;
  }> {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      throw new Error('Search query must not be empty.');
    }

    const encoded = encodeURIComponent(trimmed);
    let searchUrl: string;

    switch (engine) {
      case 'youtube':
        searchUrl = `https://www.youtube.com/results?search_query=${encoded}`;
        break;
      case 'github':
        searchUrl = `https://github.com/search?q=${encoded}`;
        break;
      case 'duckduckgo':
        searchUrl = `https://duckduckgo.com/?q=${encoded}`;
        break;
      case 'google':
      default:
        searchUrl = `https://www.google.com/search?q=${encoded}`;
        break;
    }

    const navResult = await this.navigateUrl(searchUrl, requestedBrowser, false);

    return {
      success: true,
      browser: navResult.browser,
      engine,
      query: trimmed,
      searchUrl,
      message: `Searched for "${trimmed}" on ${engine} using ${navResult.browser}.`,
    };
  }

  /**
   * Tab management actions: new_tab, close_tab, back, forward, refresh.
   */
  public static async tabAction(
    action: 'new_tab' | 'close_tab' | 'back' | 'forward' | 'refresh',
    requestedBrowser?: string,
    url?: string
  ): Promise<TabActionResult> {
    const info = this.resolveBrowser(requestedBrowser);
    if (!info.isInstalled) {
      throw new Error(`Browser "${info.appName}" is not installed on this system.`);
    }

    if (action === 'new_tab') {
      const destinationUrl = url || 'https://www.google.com';
      await this.navigateUrl(destinationUrl, info.appName, true);
      return {
        success: true,
        action,
        browser: info.appName,
        url: destinationUrl,
        message: `Opened new tab in ${info.appName}.`,
      };
    }

    if (action === 'close_tab') {
      const script = `
tell application "${info.appName}"
  if (count of windows) > 0 then
    tell front window
      close active tab
    end tell
  end if
end tell
return "ok"
`;
      await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      return {
        success: true,
        action,
        browser: info.appName,
        message: `Closed active tab in ${info.appName}.`,
      };
    }

    if (action === 'refresh') {
      const script = `
tell application "${info.appName}"
  if (count of windows) > 0 then
    tell front window
      reload active tab
    end tell
  end if
end tell
return "ok"
`;
      await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      return {
        success: true,
        action,
        browser: info.appName,
        message: `Refreshed active tab in ${info.appName}.`,
      };
    }

    if (action === 'back') {
      const script = `
tell application "System Events"
  tell process "${info.appName}"
    click menu item "Back" of menu "History" of menu bar 1
  end tell
end tell
return "ok"
`;
      await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      return {
        success: true,
        action,
        browser: info.appName,
        message: `Navigated back in ${info.appName} history.`,
      };
    }

    if (action === 'forward') {
      const script = `
tell application "System Events"
  tell process "${info.appName}"
    click menu item "Forward" of menu "History" of menu bar 1
  end tell
end tell
return "ok"
`;
      await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      return {
        success: true,
        action,
        browser: info.appName,
        message: `Navigated forward in ${info.appName} history.`,
      };
    }

    throw new Error(`Unsupported tab action: "${action}".`);
  }

  /**
   * Get URL of active tab in browser.
   */
  public static async getActiveTabUrl(requestedBrowser?: string): Promise<string | null> {
    const info = this.resolveBrowser(requestedBrowser);
    if (!info.isInstalled) return null;

    try {
      if (
        info.appName === 'Google Chrome' ||
        info.appName === 'Brave Browser' ||
        info.appName === 'Microsoft Edge'
      ) {
        const script = `
tell application "${info.appName}"
  if (count of windows) > 0 then
    return URL of active tab of front window
  else
    return "no_window"
  end if
end tell
`;
        const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 3000 });
        const res = stdout.trim();
        return res === 'no_window' ? null : res;
      }

      if (info.appName === 'Safari') {
        const script = `
tell application "Safari"
  if (count of windows) > 0 then
    return URL of front document
  else
    return "no_window"
  end if
end tell
`;
        const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 3000 });
        const res = stdout.trim();
        return res === 'no_window' ? null : res;
      }

      return null;
    } catch {
      return null;
    }
  }
}

