export interface DesktopProjectOpenResult {
  canceled: boolean;
  filePath?: string;
  name?: string;
  content?: string;
}

export interface DesktopProjectSaveResult {
  canceled: boolean;
  filePath?: string;
  name?: string;
}

export interface DesktopExportSaveResult {
  canceled: boolean;
  filePath?: string;
}

export interface DesktopLaunchProject {
  filePath: string;
  name: string;
  content: string;
}

export type DesktopMenuCommand =
  | { type: 'new' | 'open' | 'save' | 'save-as' | 'export-png' | 'export-video' }
  | { type: 'open-project-data'; filePath: string; name: string; content: string };

export interface MetroDesktopBridge {
  version: string;
  openProjectDialog: () => Promise<DesktopProjectOpenResult>;
  saveProjectFile: (payload: {
    filePath?: string | null;
    suggestedName: string;
    content: string;
    saveAs?: boolean;
  }) => Promise<DesktopProjectSaveResult>;
  saveExportFile: (payload: {
    suggestedName: string;
    mimeType: string;
    bytes: Uint8Array;
  }) => Promise<DesktopExportSaveResult>;
  consumeLaunchProject: () => Promise<DesktopLaunchProject | null>;
  onMenuCommand: (callback: (command: DesktopMenuCommand) => void) => () => void;
  setDocumentWindowState: (state: {
    title: string;
    dirty: boolean;
    filePath?: string | null;
  }) => void;
}

declare global {
  interface Window {
    metroDesktop?: MetroDesktopBridge;
  }
}

export const desktopVersion =
  (typeof window !== 'undefined' && window.metroDesktop?.version) ||
  (typeof navigator !== 'undefined'
    ? navigator.userAgent.match(/(?:TransitCanvasDesktop|MetroDesignerDesktop)\/(\d+\.\d+\.\d+)/)?.[1] || null
    : null);

export const isDesktopClient = desktopVersion !== null;

export const hasDesktopBridge = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.metroDesktop);

export const isNewerDesktopVersion = (latest: string, current: string): boolean => {
  if (!/^\d+\.\d+\.\d+$/.test(latest) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const left = latest.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
};

export async function saveDesktopExport(blob: Blob, suggestedName: string): Promise<boolean> {
  const bridge = typeof window !== 'undefined' ? window.metroDesktop : undefined;
  if (!bridge) {
    throw new Error('当前桌面环境暂不支持原生导出接口');
  }
  const buffer = await blob.arrayBuffer();
  const result = await bridge.saveExportFile({
    suggestedName,
    mimeType: (blob.type || 'application/octet-stream').split(';')[0],
    bytes: new Uint8Array(buffer)
  });
  return !result.canceled;
}
