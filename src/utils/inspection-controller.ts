import { MediaMetadata } from '../types';
import { validateMediaUrl } from './engine-parser';

export interface InspectionUiState {
  isExtracting: boolean;
  metadata: MediaMetadata | null;
  extractError: string | null;
  isTimeoutError: boolean;
  activeRequestId: string | null;
}

export interface InspectionDeps {
  inspectUrl: (
    url: string,
    options?: { requestId?: string; signal?: AbortSignal }
  ) => Promise<MediaMetadata>;
  cancelInspection: (requestId: string) => Promise<boolean>;
  onStateChange: (patch: Partial<InspectionUiState>) => void;
}

export function isTimeoutErrorMessage(message: string): boolean {
  const lower = (message || '').toLowerCase();
  return lower.includes('timed out') || lower.includes('timeout') || lower.includes('504');
}

export function isCancellationError(err: unknown): boolean {
  if (!err) return false;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  const name = (err as { name?: string })?.name;
  if (name === 'AbortError') return true;
  const msg = String((err as { message?: string })?.message || err).toLowerCase();
  return msg.includes('inspection cancelled') || msg.includes('aborted');
}

export function validateClientUrl(raw: string): string | null {
  const res = validateMediaUrl(raw);
  return res.valid ? null : res.error;
}

export class InspectionController {
  private seq = 0;
  private abortController: AbortController | null = null;
  private activeServerRequestId: string | null = null;
  private mounted = true;

  public getLatestSeq(): number {
    return this.seq;
  }

  public isMounted(): boolean {
    return this.mounted;
  }

  public markMounted(): void {
    this.mounted = true;
  }

  public cancelCurrent(
    cancelInspection?: (requestId: string) => Promise<boolean>,
    onStateChange?: (patch: Partial<InspectionUiState>) => void
  ): void {
    // Advance sequence so any still-settling promise ignores state mutation
    this.seq += 1;

    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        // ignore
      }
      this.abortController = null;
    }

    if (this.activeServerRequestId && cancelInspection) {
      const idToCancel = this.activeServerRequestId;
      this.activeServerRequestId = null;
      cancelInspection(idToCancel).catch(() => {});
    } else {
      this.activeServerRequestId = null;
    }

    if (this.mounted && onStateChange) {
      onStateChange({
        isExtracting: false,
        activeRequestId: null,
      });
    }
  }

  public async startInspection(rawUrl: string, deps: InspectionDeps): Promise<MediaMetadata | null> {
    const trimmed = (rawUrl || '').trim();
    if (!trimmed) {
      return null;
    }

    // Cancel any previous in-flight inspection first
    this.cancelCurrent(deps.cancelInspection);

    const reqSeq = ++this.seq;
    const validationErr = validateClientUrl(trimmed);
    if (validationErr) {
      if (this.mounted && reqSeq === this.seq) {
        deps.onStateChange({
          isExtracting: false,
          metadata: null,
          extractError: validationErr,
          isTimeoutError: false,
          activeRequestId: null,
        });
      }
      return null;
    }

    const serverReqId = `insp_${reqSeq}_${Date.now()}`;
    const controller = new AbortController();
    this.abortController = controller;
    this.activeServerRequestId = serverReqId;

    if (this.mounted && reqSeq === this.seq) {
      deps.onStateChange({
        isExtracting: true,
        metadata: null,
        extractError: null,
        isTimeoutError: false,
        activeRequestId: serverReqId,
      });
    }

    try {
      const data = await deps.inspectUrl(trimmed, {
        requestId: serverReqId,
        signal: controller.signal,
      });

      if (!this.mounted || reqSeq !== this.seq) {
        return null;
      }

      if (this.abortController === controller) {
        this.abortController = null;
      }
      if (this.activeServerRequestId === serverReqId) {
        this.activeServerRequestId = null;
      }

      deps.onStateChange({
        isExtracting: false,
        metadata: data,
        extractError: null,
        isTimeoutError: false,
        activeRequestId: null,
      });
      return data;
    } catch (err: unknown) {
      if (!this.mounted || reqSeq !== this.seq) {
        return null;
      }

      if (this.abortController === controller) {
        this.abortController = null;
      }
      if (this.activeServerRequestId === serverReqId) {
        this.activeServerRequestId = null;
      }

      if (isCancellationError(err)) {
        deps.onStateChange({
          isExtracting: false,
          activeRequestId: null,
        });
        return null;
      }

      const message =
        (err as { message?: string })?.message ||
        'Failed to inspect URL. You can retry analysis or start the download directly.';

      deps.onStateChange({
        isExtracting: false,
        metadata: null,
        extractError: message,
        isTimeoutError: isTimeoutErrorMessage(message),
        activeRequestId: null,
      });
      return null;
    }
  }

  public dispose(cancelInspection?: (requestId: string) => Promise<boolean>): void {
    this.cancelCurrent(cancelInspection);
    this.mounted = false;
  }
}
