import { app, BrowserWindow } from 'electron';
import * as fs from 'fs/promises';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getExceptionMessage(result: {
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
    lineNumber?: number;
    columnNumber?: number;
  };
}): string {
  const details = result.exceptionDetails;
  if (!details) return 'Unknown CDP evaluation error';

  const description = details.exception?.description || details.text || 'Unknown CDP evaluation error';
  const line = typeof details.lineNumber === 'number' ? details.lineNumber + 1 : null;
  const column = typeof details.columnNumber === 'number' ? details.columnNumber + 1 : null;

  if (line && column) {
    return `${description} (${line}:${column})`;
  }

  return description;
}

export async function maybeRunRendererCdpScript(mainWindow: BrowserWindow): Promise<void> {
  const scriptPath = process.env.GREP_RENDERER_CDP_SCRIPT;
  if (!scriptPath) return;

  const timeoutMs = Number(process.env.GREP_RENDERER_CDP_TIMEOUT_MS || 120000);
  const shouldExit = process.env.GREP_RENDERER_CDP_EXIT !== '0';
  const resultFile = process.env.GREP_RENDERER_CDP_RESULT_FILE || null;
  const argsJson = process.env.GREP_RENDERER_CDP_ARGS_JSON || '{}';

  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch (error) {
    const message = `Invalid GREP_RENDERER_CDP_ARGS_JSON: ${error instanceof Error ? error.message : String(error)}`;
    console.error('[Renderer CDP]', message);
    if (shouldExit) app.exit(1);
    throw new Error(message);
  }

  let attachedHere = false;

  try {
    const source = await fs.readFile(scriptPath, 'utf8');
    const wc = mainWindow.webContents;

    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }

    await wc.debugger.sendCommand('Runtime.enable');

    const readyDeadline = Date.now() + Math.max(timeoutMs, 1000);
    while (Date.now() < readyDeadline) {
      const readyState = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });

      if (readyState.result?.value === 'complete') {
        break;
      }

      await sleep(100);
    }

    const expression = `
      (async () => {
        const args = ${JSON.stringify(args)};
        const module = { exports: undefined };
        ${source}
        if (typeof module.exports !== 'function') {
          throw new Error('CDP script must assign module.exports = async function(args) { ... }');
        }
        return await module.exports(args);
      })()
    `;

    const result = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error(getExceptionMessage(result));
    }

    const serializedResult = JSON.stringify(result.result?.value ?? null);
    console.log('[Renderer CDP] Result:', serializedResult);
    if (resultFile) {
      await fs.writeFile(resultFile, serializedResult, 'utf8');
    }

    if (shouldExit) {
      app.exit(0);
    }
  } catch (error) {
    console.error('[Renderer CDP] Failed:', error);
    if (resultFile) {
      const payload = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
      await fs.writeFile(resultFile, payload, 'utf8');
    }
    if (shouldExit) {
      app.exit(1);
      return;
    }
    throw error;
  } finally {
    if (attachedHere && mainWindow.webContents.debugger.isAttached()) {
      try {
        mainWindow.webContents.debugger.detach();
      } catch (error) {
        console.warn('[Renderer CDP] Failed to detach debugger:', error);
      }
    }
  }
}
