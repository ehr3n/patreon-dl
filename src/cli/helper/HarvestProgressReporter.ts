import fs from 'fs';
import path from 'path';
import type Downloader from '../../downloaders/Downloader.js';
import { TargetSkipReason } from '../../downloaders/DownloaderEvent.js';
import type { IDownloadTask, DownloadProgress, DownloadTaskSkipReason } from '../../downloaders/task/DownloadTask.js';
import type { IDownloadTaskBatch } from '../../downloaders/task/DownloadTaskBatch.js';

type ProgressStatus =
  'queued' | 'fetching' | 'saving-info' | 'downloading' | 'waiting' |
  'retrying' | 'completed' | 'skipped' | 'failed' | 'aborted';

type ProgressEvent = {
  schemaVersion: 1;
  sequence: number;
  at: string;
  kind: 'run' | 'target' | 'file' | 'delay';
  status: ProgressStatus;
  targetIndex?: number;
  targetTotal?: number;
  postID?: string;
  title?: string;
  phase?: string;
  reason?: string;
  file?: {
    key: string;
    id: string;
    type: string;
    name: string;
    bytesDownloaded?: number;
    percent?: number;
  };
};

const SKIP_REASON_CODES: Record<TargetSkipReason, string> = {
  [TargetSkipReason.Inaccessible]: 'inaccessible',
  [TargetSkipReason.AlreadyDownloaded]: 'already-downloaded',
  [TargetSkipReason.UnmetMediaTypeCriteria]: 'media-criteria',
  [TargetSkipReason.NotInTier]: 'tier-criteria',
  [TargetSkipReason.PublishDateOutOfRange]: 'publish-date'
};

export default class HarvestProgressReporter {
  readonly #file: string;
  readonly #targetIDs: string[];
  #sequence = 0;
  #lastFileProgress = new Map<string, { at: number; percent: number }>();

  constructor(file: string, targetURLs: string[]) {
    this.#file = path.resolve(file);
    this.#targetIDs = targetURLs.map(extractPostID);
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(this.#file, '', 'utf-8');
  }

  start() {
    this.#write({
      kind: 'run',
      status: 'fetching',
      targetTotal: this.#targetIDs.length
    });
    this.#targetIDs.forEach((postID, index) => this.#write({
      kind: 'target',
      status: 'queued',
      targetIndex: index + 1,
      targetTotal: this.#targetIDs.length,
      ...(postID ? { postID } : {})
    }));
  }

  attach(downloader: Downloader<any>, targetIndex: number) {
    const ordinal = targetIndex + 1;
    const fallbackPostID = this.#targetIDs[targetIndex];
    let postID = fallbackPostID;
    let title = '';
    const attachedBatches = new Set<number>();

    downloader.on('fetchBegin', () => {
      this.#writeTarget(ordinal, postID, title, 'fetching', 'fetch');
    });
    downloader.on('targetBegin', ({ target }) => {
      if (target.type !== 'post') {
        return;
      }
      postID = target.id;
      title = sanitizeTitle(target.title);
      this.#writeTarget(ordinal, postID, title, 'fetching', 'post');
    });
    downloader.on('phaseBegin', (args) => {
      const { target, phase } = args;
      if (target.type !== 'post') {
        return;
      }
      postID = target.id;
      title = sanitizeTitle(target.title);
      if (phase === 'batchDownload') {
        const batch = args.batch;
        if (!attachedBatches.has(batch.id)) {
          attachedBatches.add(batch.id);
          this.#attachBatch(batch, ordinal, postID);
        }
        this.#writeTarget(ordinal, postID, title, 'downloading', phase);
        return;
      }
      this.#writeTarget(ordinal, postID, title, phase === 'saveInfo' ? 'saving-info' : 'downloading', phase);
    });
    downloader.on('targetEnd', (args) => {
      if (args.target.type !== 'post') {
        return;
      }
      postID = args.target.id;
      title = sanitizeTitle(args.target.title);
      this.#writeTarget(
        ordinal,
        postID,
        title,
        args.isSkipped ? 'skipped' : 'completed',
        'done',
        args.isSkipped ? SKIP_REASON_CODES[args.skipReason] : undefined
      );
    });
    downloader.on('end', ({ aborted, error }) => {
      if (aborted || error) {
        this.#writeTarget(ordinal, postID, title, aborted ? 'aborted' : 'failed', 'done', aborted ? 'aborted' : 'downloader-error');
      }
    });
  }

  failTarget(targetIndex: number, reason = 'downloader-error') {
    const ordinal = targetIndex + 1;
    this.#writeTarget(ordinal, this.#targetIDs[targetIndex], '', 'failed', 'done', reason);
  }

  delay(targetIndex: number, delayMs: number) {
    this.#write({
      kind: 'delay',
      status: 'waiting',
      targetIndex: targetIndex + 1,
      targetTotal: this.#targetIDs.length,
      postID: this.#targetIDs[targetIndex],
      phase: 'polite-delay',
      reason: `${Math.round(delayMs / 1000)}s`
    });
  }

  end(failed: boolean, aborted = false) {
    this.#write({
      kind: 'run',
      status: aborted ? 'aborted' : failed ? 'failed' : 'completed',
      targetTotal: this.#targetIDs.length
    });
  }

  #attachBatch(batch: IDownloadTaskBatch, targetIndex: number, postID: string) {
    batch.on('taskStart', ({ task }) => this.#writeFile(targetIndex, postID, task, 'downloading'));
    batch.on('taskProgress', ({ task, progress }) => {
      if (progress && this.#shouldWriteProgress(task, progress)) {
        this.#writeFile(targetIndex, postID, task, 'downloading', undefined, progress);
      }
    });
    batch.on('taskComplete', ({ task }) => this.#writeFile(targetIndex, postID, task, 'completed', undefined, task.getProgress()));
    batch.on('taskAbort', ({ task }) => this.#writeFile(targetIndex, postID, task, 'aborted', 'aborted'));
    batch.on('taskSkip', ({ task, reason }) => this.#writeFile(targetIndex, postID, task, 'skipped', getFileSkipReason(reason)));
    batch.on('taskError', ({ error, willRetry }) => this.#writeFile(
      targetIndex,
      postID,
      error.task,
      willRetry ? 'retrying' : 'failed',
      willRetry ? 'retry' : 'download-error',
      error.task.getProgress()
    ));
  }

  #shouldWriteProgress(task: IDownloadTask, progress: DownloadProgress) {
    const key = getFileKey(task);
    const now = Date.now();
    const percent = Math.floor(progress.percent || 0);
    const previous = this.#lastFileProgress.get(key);
    if (previous && now - previous.at < 2000 && percent - previous.percent < 5) {
      return false;
    }
    this.#lastFileProgress.set(key, { at: now, percent });
    return true;
  }

  #writeTarget(index: number, postID: string, title: string, status: ProgressStatus, phase: string, reason?: string) {
    this.#write({
      kind: 'target',
      status,
      targetIndex: index,
      targetTotal: this.#targetIDs.length,
      ...(postID ? { postID } : {}),
      ...(title ? { title } : {}),
      phase,
      ...(reason ? { reason } : {})
    });
  }

  #writeFile(
    targetIndex: number,
    postID: string,
    task: IDownloadTask,
    status: ProgressStatus,
    reason?: string,
    progress?: DownloadProgress | null
  ) {
    const name = sanitizeFilename(task.resolvedDestFilename);
    this.#write({
      kind: 'file',
      status,
      targetIndex,
      targetTotal: this.#targetIDs.length,
      postID,
      ...(reason ? { reason } : {}),
      file: {
        key: getFileKey(task),
        id: task.srcEntity.id,
        type: sanitizeType(task.srcEntity.type),
        name,
        ...(progress ? {
          bytesDownloaded: Math.max(0, Math.round(progress.sizeDownloaded * 1024)),
          ...(progress.percent !== undefined ? { percent: Math.max(0, Math.min(100, progress.percent)) } : {})
        } : {})
      }
    });
  }

  #write(event: Omit<ProgressEvent, 'schemaVersion' | 'sequence' | 'at'>) {
    const record: ProgressEvent = {
      schemaVersion: 1,
      sequence: ++this.#sequence,
      at: new Date().toISOString(),
      ...event
    };
    fs.appendFileSync(this.#file, `${JSON.stringify(record)}\n`, 'utf-8');
  }
}

function extractPostID(value: string) {
  return value.match(/\/posts\/(?:[^/?#]+-)?(\d+)(?:[/?#]|$)/u)?.[1] || '';
}

function getFileKey(task: IDownloadTask) {
  return `${sanitizeType(task.srcEntity.type)}:${sanitizeType(task.srcEntity.id)}:${task.id}`;
}

function getFileSkipReason(reason: DownloadTaskSkipReason) {
  switch (reason.name) {
    case 'destFileExists': return 'already-exists';
    case 'includeMediaByFilenameUnfulfilled': return 'filename-criteria';
    case 'dependentTaskNotCompleted': return 'dependency';
    default: return 'skipped';
  }
}

function sanitizeTitle(value: string | null | undefined) {
  return (value || '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 300);
}

function sanitizeFilename(value: string | null | undefined) {
  return path.basename(value || '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 300);
}

function sanitizeType(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, '-').slice(0, 80) || 'media';
}
