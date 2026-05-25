import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AcpClient } from './acpClient';
import { PermissionRequestHandler, SessionManager } from './sessionManager';
import { ChatPanelProvider } from './chatPanel';

const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';
const APPROVED_BINARIES_KEY = 'hermes.approvedBinaries';

function extractModelFromHermesConfig(content: string): string | null {
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const modelMatch = /^(\s*)model:\s*(.*)$/.exec(line);
    if (!modelMatch) continue;

    const modelIndent = modelMatch[1].length;
    const inlineValue = modelMatch[2].trim();
    if (inlineValue) {
      return inlineValue;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const childLine = lines[j];
      if (!childLine.trim() || childLine.trimStart().startsWith('#')) continue;

      const childIndent = childLine.match(/^\s*/)?.[0].length ?? 0;
      if (childIndent <= modelIndent) break;

      const defaultMatch = /^\s*default:\s*(\S+)/.exec(childLine);
      if (defaultMatch) {
        return defaultMatch[1];
      }
    }
  }

  return null;
}

function readHermesModel(): { model: string; source: 'env' | 'config' | 'fallback' } {
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    const model = extractModelFromHermesConfig(content);
    if (model) {
      return { model, source: 'config' };
    }
  } catch {
    // Fall through to the built-in Sonnet default.
  }

  return { model: DEFAULT_SONNET_MODEL, source: 'fallback' };
}

function readApprovalsDisabled(): boolean {
  // Returns true when ~/.hermes/config.yaml has `approvals.mode: false|off|no`.
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    const lines = content.split(/\r?\n/);

    let inApprovals = false;
    let approvalsIndent = 0;

    for (const line of lines) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;

      const indent = line.search(/\S/);
      const trimmed = line.trim();

      if (trimmed === 'approvals:') {
        inApprovals = true;
        approvalsIndent = indent;
        continue;
      }

      if (inApprovals) {
        if (indent <= approvalsIndent) break;

        const modeMatch = trimmed.match(/^mode:\s*(.+)/);
        if (modeMatch) {
          const value = modeMatch[1].trim().toLowerCase();
          return value === 'false' || value === 'off' || value === 'no';
        }
      }
    }
  } catch {
    // Config not accessible — not disabled, show dialog.
  }
  return false;
}

function readHermesVersion(hermesPath: string): string {
  const attempts: string[][] = [['--version'], ['version']];
  for (const args of attempts) {
    try {
      const output = execFileSync(hermesPath, args, { timeout: 3000, encoding: 'utf8' }).trim();
      if (output) return output.split(/\r?\n/, 1)[0].trim();
    } catch {
      // try next option
    }
  }
  return '';
}

function readConfiguredHermesPath(): { value: string; workspaceOverrideIgnored: boolean } {
  const hermesConfig = vscode.workspace.getConfiguration('hermes');
  const inspected = hermesConfig.inspect<string>('path');
  const workspaceOverrideIgnored = !!(inspected?.workspaceValue || inspected?.workspaceFolderValue);
  const value = inspected?.globalValue ?? inspected?.defaultValue ?? 'hermes';
  return { value, workspaceOverrideIgnored };
}

function resolveHermesBinary(configuredPath: string): string {
  let hermesPath = configuredPath;

  if (hermesPath !== 'hermes' && !path.isAbsolute(hermesPath)) {
    throw new Error('hermes.path must be an absolute path or the default "hermes" value');
  }

  if (hermesPath === 'hermes') {
    try {
      const resolved = execFileSync('which', ['hermes'], { timeout: 3000, encoding: 'utf8' }).trim();
      if (resolved) hermesPath = resolved;
    } catch {
      // not in PATH
    }

    if (hermesPath === 'hermes') {
      const tryPaths = [
        path.join(os.homedir(), '.local', 'bin', 'hermes'),
        '/usr/local/bin/hermes',
        '/usr/bin/hermes',
      ];
      for (const candidate of tryPaths) {
        try {
          if (fs.existsSync(candidate)) {
            hermesPath = candidate;
            break;
          }
        } catch {
          // skip unreadable candidate
        }
      }
    }
  }

  if (!path.isAbsolute(hermesPath)) {
    throw new Error(`Unable to resolve hermes binary from setting "${configuredPath}"`);
  }
  if (!fs.existsSync(hermesPath)) {
    throw new Error(`Configured hermes binary does not exist: ${hermesPath}`);
  }

  return hermesPath;
}

async function ensureTrustedBinary(
  context: vscode.ExtensionContext,
  hermesPath: string,
): Promise<boolean> {
  const approved = context.globalState.get<string[]>(APPROVED_BINARIES_KEY, []);
  if (approved.includes(hermesPath)) return true;

  const allow = 'Allow';
  const choice = await vscode.window.showWarningMessage(
    `Hermes wants to launch this local binary:\n${hermesPath}\n\nOnly allow binaries you trust.`,
    { modal: true },
    allow,
  );
  if (choice !== allow) return false;

  await context.globalState.update(APPROVED_BINARIES_KEY, [...new Set([...approved, hermesPath])]);
  return true;
}

function summarizePermissionRequest(params: unknown): string {
  if (!params || typeof params !== 'object') return 'Hermes requested permission for an action.';
  const record = params as Record<string, unknown>;
  const toolName = typeof record.toolName === 'string'
    ? record.toolName
    : typeof record.title === 'string'
      ? record.title
      : typeof record.kind === 'string'
        ? record.kind
        : 'an action';
  const reason = typeof record.reason === 'string'
    ? record.reason
    : typeof record.description === 'string'
      ? record.description
      : '';
  return reason
    ? `Hermes requested permission for ${toolName}: ${reason}`
    : `Hermes requested permission for ${toolName}.`;
}

function optionIdByIntent(params: unknown, intent: 'allow' | 'deny'): string | null {
  if (!params || typeof params !== 'object') return null;
  const options = (params as { options?: Array<Record<string, unknown>> }).options;
  if (!Array.isArray(options)) return null;

  const preferredAllow = ['allow_once', 'allow', 'approve', 'yes'];
  const preferredDeny = ['deny_once', 'deny', 'reject', 'no'];
  const preferred = intent === 'allow' ? preferredAllow : preferredDeny;

  for (const keyword of preferred) {
    const match = options.find((option) => {
      const id = typeof option.optionId === 'string' ? option.optionId : typeof option.id === 'string' ? option.id : '';
      return id.toLowerCase().includes(keyword);
    });
    if (match) {
      return (typeof match.optionId === 'string' ? match.optionId : match.id) as string;
    }
  }

  if (intent === 'allow') {
    const fallback = options.find((option) => {
      const id = typeof option.optionId === 'string' ? option.optionId : typeof option.id === 'string' ? option.id : '';
      return id && !/deny|reject|no/i.test(id);
    });
    return (typeof fallback?.optionId === 'string' ? fallback.optionId : fallback?.id as string | undefined) ?? null;
  }

  return null;
}

let client: AcpClient | null = null;
let outputChannel: vscode.OutputChannel;
let cachedHermesVersion = '';
let lastHermesPathForVersion = '';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Hermes');
  context.subscriptions.push(outputChannel);

  const configuredHermes = readConfiguredHermesPath();
  if (configuredHermes.workspaceOverrideIgnored) {
    outputChannel.appendLine('[security] Ignoring workspace-scoped hermes.path override');
  }

  let hermesPath = configuredHermes.value;

  outputChannel.appendLine(`[hermes] homedir: ${os.homedir()}`);
  outputChannel.appendLine(`[hermes] platform: ${process.platform}`);
  try {
    hermesPath = resolveHermesBinary(hermesPath);
    outputChannel.appendLine(`[hermes] binary: ${hermesPath}`);
  } catch (err) {
    outputChannel.appendLine(`[security] invalid Hermes binary: ${err}`);
  }

  const hermesConfig = vscode.workspace.getConfiguration('hermes');
  const debugLogs = hermesConfig.get<boolean>('debugLogs', false);

  client = new AcpClient(
    hermesPath,
    debugLogs ? { HERMES_LOG_LEVEL: 'DEBUG' } : {},
    debugLogs,
  );

  if (debugLogs) {
    outputChannel.show(true);
    outputChannel.appendLine('[hermes] ACP diagnostic logging enabled');
  }

  client.on('log', (line: string) => outputChannel.appendLine(line));
  client.on('exit', (code: number) => {
    outputChannel.appendLine(`[hermes acp exited: code ${code}]`);
    setStatus('disconnected');
  });

  let dangerouslyApproved = false;

  const permissionHandler: PermissionRequestHandler = async (_method, params) => {
    const allowOptionId = optionIdByIntent(params, 'allow');
    const denyOptionId = optionIdByIntent(params, 'deny');

    // Approvals disabled via config — auto-allow without dialog.
    if (readApprovalsDisabled()) {
      outputChannel.appendLine('[security] approvals disabled in config, auto-allowing');
      if (allowOptionId) {
        return { outcome: 'selected', optionId: allowOptionId };
      }
      throw new Error('Permission denied: no allow option');
    }

    // Allow Always was clicked earlier — suppress future dialogs.
    if (dangerouslyApproved) {
      outputChannel.appendLine('[security] allow-always active, auto-allowing');
      if (allowOptionId) {
        return { outcome: 'selected', optionId: allowOptionId };
      }
      throw new Error('Permission denied: no allow option');
    }

    const deny = 'Deny';
    const allowOnce = 'Allow Once';
    const allowAlways = 'Allow Always';
    const choice = await vscode.window.showWarningMessage(
      summarizePermissionRequest(params),
      { modal: true },
      deny,
      allowOnce,
      allowAlways,
    );

    if (choice === allowAlways) {
      dangerouslyApproved = true;
      outputChannel.appendLine('[security] allow-always activated — future requests auto-allowed');
      if (allowOptionId) {
        return { outcome: 'selected', optionId: allowOptionId };
      }
      throw new Error('Permission denied: no allow option');
    }

    if (choice === allowOnce && allowOptionId) {
      outputChannel.appendLine('[security] permission granted once');
      return { outcome: 'selected', optionId: allowOptionId };
    }

    if (denyOptionId) {
      outputChannel.appendLine('[security] permission denied');
      return { outcome: 'selected', optionId: denyOptionId };
    }

    throw new Error('Permission denied by user');
  };

  const session = new SessionManager(client, line => outputChannel.appendLine(line), permissionHandler);
  const { model: hermesModel } = readHermesModel();
  const panel = new ChatPanelProvider(
    context.extensionUri,
    session,
    hermesModel,
    '',
    context,
    line => outputChannel.appendLine(line),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hermes.openChat', async () => {
      outputChannel.appendLine('[ui] open chat');
      await vscode.commands.executeCommand('hermes.chatView.focus');
      await ensureConnected();
    }),

    vscode.commands.registerCommand('hermes.newSession', () => {
      outputChannel.appendLine('[ui] new session');
      session.reset();
      panel.post({ type: 'clear' });
    }),
  );

  // Status bar
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusItem.text = '$(circle-outline) Hermes';
  statusItem.command = 'hermes.openChat';
  statusItem.show();
  context.subscriptions.push(statusItem);

  function setStatus(state: 'connected' | 'disconnected' | 'connecting'): void {
    const icons: Record<string, string> = {
      connected: '$(circle-filled)',
      disconnected: '$(circle-outline)',
      connecting: '$(loading~spin)',
    };
    statusItem.text = `${icons[state]} Hermes`;
    panel.post({ type: 'status', status: state });
  }

  async function ensureConnected(): Promise<void> {
    if (!client) return;
    if (!vscode.workspace.isTrusted) {
      outputChannel.appendLine('[security] workspace is not trusted; Hermes launch blocked');
      setStatus('disconnected');
      void vscode.window.showWarningMessage('Hermes is disabled until this workspace is trusted.');
      return;
    }

    try {
      hermesPath = resolveHermesBinary(readConfiguredHermesPath().value);
    } catch (err) {
      setStatus('disconnected');
      vscode.window.showErrorMessage(`Hermes: invalid binary path — ${err}`);
      return;
    }

    const approved = await ensureTrustedBinary(context, hermesPath);
    if (!approved) {
      outputChannel.appendLine('[security] Hermes launch cancelled by user');
      setStatus('disconnected');
      return;
    }
    // Only read version if client is not already running or if hermesPath changed
    // to avoid repeated blocking calls on every ensureConnected() invocation
    if (!client.running || lastHermesPathForVersion !== hermesPath) {
      const hermesVersion = readHermesVersion(hermesPath);
      lastHermesPathForVersion = hermesPath;
      if (hermesVersion) {
        cachedHermesVersion = hermesVersion;
      } else {
        cachedHermesVersion = '';
      }
    }
    if (cachedHermesVersion) {
      panel.updateVersion(cachedHermesVersion);
    } else {
      panel.updateVersion('');
    }
    client.setHermesPath(hermesPath);

    outputChannel.appendLine('[acp] connecting');
    setStatus('connecting');
    try {
      await client.start();
      outputChannel.appendLine('[acp] connected');
      setStatus('connected');
    } catch (err) {
      outputChannel.appendLine(`[acp] connect failed: ${err}`);
      setStatus('disconnected');
      vscode.window.showErrorMessage(`Hermes: failed to start — ${err}`);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void ensureConnected();
    }),
  );

  // Auto-connect
  if (vscode.workspace.isTrusted) {
    void ensureConnected();
  } else {
    setStatus('disconnected');
  }
}

export function deactivate(): void {
  client?.stop();
}
