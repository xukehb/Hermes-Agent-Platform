export interface DesktopUpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | null | Array<{ version?: string; note?: string | null }>;
}

export interface DesktopDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface DesktopUpdaterEvents {
  'update-available': DesktopUpdateInfo;
  'update-not-available': DesktopUpdateInfo;
  'download-progress': DesktopDownloadProgress;
  'update-downloaded': DesktopUpdateInfo;
  error: Error;
}

export interface DesktopUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on<K extends keyof DesktopUpdaterEvents>(
    event: K,
    listener: (value: DesktopUpdaterEvents[K]) => void,
  ): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface VersionDetails {
  version: string;
  releaseDate?: string;
  releaseNotes: string;
}

export type DesktopUpdateState =
  | { status: 'idle'; currentVersion: string }
  | { status: 'checking'; currentVersion: string }
  | ({ status: 'available'; currentVersion: string } & VersionDetails)
  | ({ status: 'downloading'; currentVersion: string } & VersionDetails & DesktopDownloadProgress)
  | ({ status: 'downloaded'; currentVersion: string } & VersionDetails)
  | {
      status: 'error';
      currentVersion: string;
      version?: string;
      message: string;
      retryable: boolean;
    };

export interface DesktopUpdateControllerOptions {
  updater: DesktopUpdaterAdapter;
  isPackaged: boolean;
  currentVersion: string;
  onCheckError?: (error: Error) => void;
}

type StateListener = (state: DesktopUpdateState) => void;

function normalizeReleaseNotes(notes: DesktopUpdateInfo['releaseNotes']): string {
  if (typeof notes === 'string') return notes.trim();
  if (!Array.isArray(notes)) return '';
  return notes
    .map((item) => item.note?.trim())
    .filter((note): note is string => Boolean(note))
    .join('\n\n');
}

function detailsFrom(info: DesktopUpdateInfo): VersionDetails {
  return {
    version: info.version,
    ...(info.releaseDate ? { releaseDate: info.releaseDate } : {}),
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DesktopUpdateController {
  private state: DesktopUpdateState;
  private readonly listeners = new Set<StateListener>();
  private checkedOnStartup = false;
  private downloadPromise: Promise<void> | null = null;
  private available: VersionDetails | null = null;

  constructor(private readonly options: DesktopUpdateControllerOptions) {
    this.state = { status: 'idle', currentVersion: options.currentVersion };
    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    this.registerUpdaterEvents();
  }

  getState(): DesktopUpdateState {
    return { ...this.state };
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async checkOnStartup(): Promise<void> {
    if (!this.options.isPackaged || this.checkedOnStartup) return;
    this.checkedOnStartup = true;
    this.setState({ status: 'checking', currentVersion: this.options.currentVersion });
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.options.onCheckError?.(normalized);
      this.setState({ status: 'idle', currentVersion: this.options.currentVersion });
    }
  }

  async checkForUpdates(): Promise<DesktopUpdateState> {
    if (!this.options.isPackaged) {
      this.setState({ status: 'idle', currentVersion: this.options.currentVersion });
      return this.getState();
    }
    this.setState({ status: 'checking', currentVersion: this.options.currentVersion });
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.options.onCheckError?.(normalized);
      this.setState({ status: 'idle', currentVersion: this.options.currentVersion });
    }
    return this.getState();
  }

  download(): Promise<void> {
    if (this.downloadPromise) return this.downloadPromise;
    if (!this.available) return Promise.reject(new Error('没有可下载的更新'));

    this.setState({
      status: 'downloading',
      currentVersion: this.options.currentVersion,
      ...this.available,
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
    });

    this.downloadPromise = this.options.updater.downloadUpdate()
      .then(() => undefined)
      .catch((error) => {
        this.setState({
          status: 'error',
          currentVersion: this.options.currentVersion,
          ...(this.available?.version ? { version: this.available.version } : {}),
          message: errorMessage(error),
          retryable: true,
        });
        throw error;
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    return this.downloadPromise;
  }

  quitAndInstall(): void {
    if (this.state.status !== 'downloaded') throw new Error('更新尚未下载完成');
    this.options.updater.quitAndInstall(false, true);
  }

  private registerUpdaterEvents(): void {
    this.options.updater.on('update-available', (info) => {
      this.available = detailsFrom(info);
      this.setState({
        status: 'available',
        currentVersion: this.options.currentVersion,
        ...this.available,
      });
    });
    this.options.updater.on('update-not-available', () => {
      this.available = null;
      this.setState({ status: 'idle', currentVersion: this.options.currentVersion });
    });
    this.options.updater.on('download-progress', (progress) => {
      if (!this.available) return;
      this.setState({
        status: 'downloading',
        currentVersion: this.options.currentVersion,
        ...this.available,
        percent: Math.max(0, Math.min(100, progress.percent)),
        bytesPerSecond: Math.max(0, progress.bytesPerSecond),
        transferred: Math.max(0, progress.transferred),
        total: Math.max(0, progress.total),
      });
    });
    this.options.updater.on('update-downloaded', (info) => {
      this.available = detailsFrom(info);
      this.setState({
        status: 'downloaded',
        currentVersion: this.options.currentVersion,
        ...this.available,
      });
    });
    this.options.updater.on('error', (error) => {
      if (!this.available) {
        this.options.onCheckError?.(error);
        this.setState({ status: 'idle', currentVersion: this.options.currentVersion });
        return;
      }
      this.setState({
        status: 'error',
        currentVersion: this.options.currentVersion,
        version: this.available.version,
        message: errorMessage(error),
        retryable: true,
      });
    });
  }

  private setState(state: DesktopUpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener(this.getState());
  }
}
