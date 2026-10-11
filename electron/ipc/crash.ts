import { app, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function getCrashReportsDir(): string {
  return path.join(app.getPath('userData'), 'crash-reports');
}

async function writeCrashReportFiles(report: any): Promise<string> {
  const dir = getCrashReportsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const sanitizedTimestamp = (report.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
  const baseName = `crash-${sanitizedTimestamp}-${report.reportId || 'unknown'}`;
  const jsonPath = path.join(dir, `${baseName}.json`);

  await fs.promises.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  // Rotate old crash reports: keep max 20
  try {
    const files = await fs.promises.readdir(dir);
    const reportFiles = files
      .filter((f) => f.startsWith('crash-') && (f.endsWith('.json') || f.endsWith('.md')));

    const baseNames = Array.from(new Set(reportFiles.map((f) => f.replace(/\.(json|md)$/, ''))));
    if (baseNames.length > 20) {
      baseNames.sort();
      const toDelete = baseNames.slice(0, baseNames.length - 20);
      for (const base of toDelete) {
        await fs.promises.unlink(path.join(dir, `${base}.json`)).catch(() => {});
        await fs.promises.unlink(path.join(dir, `${base}.md`)).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[AeonStagery] Failed to rotate crash reports:', err);
  }

  return jsonPath;
}

export function recordRendererCrash(details: Electron.RenderProcessGoneDetails): string {
  const reportId = `crash-hard-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  const report = {
    reportId,
    timestamp: new Date().toISOString(),
    tier: 3,
    surface: 'editor',
    error: {
      name: 'RenderProcessGone',
      message: `Renderer process terminated unexpectedly (Reason: ${details.reason}, ExitCode: ${details.exitCode})`,
    },
    environment: {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    breadcrumbs: [],
    redacted: true,
  };
  void writeCrashReportFiles(report);
  return reportId;
}

export function registerCrashHandlers() {
  ipcMain.handle('crash:record', async (_event, report) => {
    try {
      const filePath = await writeCrashReportFiles(report);
      return { success: true, reportId: report.reportId, filePath };
    } catch (error: any) {
      console.error('[AeonStagery] Failed to record crash report:', error);
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  // Real environment metadata (process.versions / app version) for crash reports.
  // The renderer process cannot read these, so it asks the main process.
  ipcMain.handle('crash:getEnvironment', async () => {
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron || 'unknown',
      chromeVersion: process.versions.chrome || 'unknown',
      nodeVersion: process.versions.node || 'unknown',
      platform: process.platform,
      arch: process.arch,
    };
  });

  ipcMain.handle('crash:openReportDir', async () => {
    const dir = getCrashReportsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
    return { success: true };
  });

  ipcMain.handle('crash:getLatestReport', async () => {
    try {
      const dir = getCrashReportsDir();
      if (!fs.existsSync(dir)) return null;
      const files = await fs.promises.readdir(dir);
      const jsonFiles = files.filter((f) => f.startsWith('crash-') && f.endsWith('.json')).sort();
      if (jsonFiles.length === 0) return null;
      const latest = jsonFiles[jsonFiles.length - 1];
      const content = await fs.promises.readFile(path.join(dir, latest), 'utf8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[AeonStagery] Failed to get latest crash report:', error);
      return null;
    }
  });
}
