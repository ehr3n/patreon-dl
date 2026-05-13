import fs from 'fs';
import path from 'path';

export type ArchiveState = {
  schemaVersion: 1;
  updatedAt: string;
  outDir?: string;
  inventory?: {
    current?: ArchiveInventoryRef;
    lastFull?: ArchiveInventoryRun;
    lastDelta?: ArchiveInventoryDelta;
  };
  targets?: {
    lastSelection?: ArchiveTargetSelection;
    files?: Record<string, ArchiveTargetSelection>;
  };
  harvest?: {
    lastReport?: ArchiveHarvestReportRef;
  };
};

export type ArchiveInventoryRef = {
  path: string;
  updatedAt: string;
  totalPosts: number;
  baseInventory?: string | null;
  deltaInventory?: string | null;
  newPosts?: number;
  updatedPosts?: number;
};

export type ArchiveInventoryRun = {
  path: string;
  startedAt: string;
  completedAt: string;
  totalPosts: number;
  newPosts: number;
  skippedExistingPosts?: number;
  aborted: boolean;
  limited: boolean;
  limit: number | null;
};

export type ArchiveInventoryDelta = {
  path: string;
  baseInventory: string | null;
  startedAt: string;
  completedAt: string;
  basePosts: number;
  deltaPosts: number;
  newPosts: number;
  updatedPosts: number;
  skippedExistingPosts: number;
  stopReason: string;
  aborted: boolean;
  limited: boolean;
  limit: number | null;
};

export type ArchiveTargetSelection = {
  path: string;
  sourceInventory: string;
  generatedAt: string;
  selectedPosts: number;
  mediaTypes: string[];
  tags: string[];
  limit: number | null;
};

export type ArchiveHarvestReportRef = {
  path: string | null;
  generatedAt: string;
  inventory: string;
  targets: string;
  database: string;
  counts: Record<string, number | boolean>;
};

const ARCHIVE_STATE_FILENAME = 'archive-state.json';

export function updateArchiveState(outDir: string, updater: (state: ArchiveState) => void) {
  const stateFile = getArchiveStatePath(outDir);
  const state = readArchiveState(stateFile);
  state.updatedAt = new Date().toISOString();
  state.outDir = toArchiveStatePath(outDir, outDir) || undefined;
  updater(state);
  writeJSONAtomic(stateFile, state);
  return state;
}

export function getArchiveStatePath(outDir: string) {
  return path.join(outDir, '.patreon-dl', ARCHIVE_STATE_FILENAME);
}

export function toArchiveStatePath(outDir: string, file: string | null | undefined) {
  if (!file) {
    return null;
  }
  const resolvedOutDir = path.resolve(outDir);
  const resolvedFile = path.resolve(file);
  const relative = path.relative(resolvedOutDir, resolvedFile);
  if (!relative) {
    return '.';
  }
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return resolvedFile;
}

export function writeJSONAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  fs.renameSync(tempFile, file);
}

function readArchiveState(file: string): ArchiveState {
  if (!fs.existsSync(file)) {
    return createArchiveState();
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ArchiveState>;
  return {
    ...createArchiveState(),
    ...parsed,
    schemaVersion: 1
  };
}

function createArchiveState(): ArchiveState {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString()
  };
}
