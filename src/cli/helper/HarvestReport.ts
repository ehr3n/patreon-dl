import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getCLIOptions } from '../CLIOptions.js';
import CommandLineParser from '../CommandLineParser.js';
import {
  CONTENT_MEDIA_TYPES,
  getContentMediaTypes,
  readInventoryPosts,
  type ContentMediaType,
  type InventoryPostRecord
} from './InventorySelect.js';
import { toArchiveStatePath, updateArchiveState, writeJSONAtomic } from './ArchiveState.js';

export type HarvestReportResult = false | {
  hasError: boolean;
};

type DBPostRow = {
  content_id: string;
  url: string | null;
};

type DBMediaRow = {
  content_id: string;
  media_id: string;
  media_type: string;
  download_path: string | null;
  is_preview: number | null;
};

type StatusCachePostEntry = {
  lastDownloaded?: string;
  lastDownloadHasErrors?: boolean;
  lastDestDir?: string;
  lastTargetInfo?: {
    id?: string | null;
  };
};

type StatusCacheState = {
  files: string[];
  postsByID: Map<string, StatusCachePostEntry>;
};

type HarvestDBState = {
  exists: boolean;
  postsByID: Map<string, DBPostRow>;
  postsByURL: Map<string, DBPostRow>;
  mediaByPostID: Map<string, DBMediaRow[]>;
  totalPosts: number;
  totalMedia: number;
};

type HarvestReportPost = {
  id?: string | null;
  url?: string | null;
  title?: string | null;
  publishedAt?: string | null;
};

type HarvestReportData = {
  schemaVersion: 1;
  generatedAt: string;
  paths: {
    outDir: string;
    inventory: string;
    targets: string;
    database: string;
    reportJSON: string | null;
  };
  statusCaches: {
    files: string[];
    postEntries: number;
  };
  targets: {
    targetURLs: number;
    uniqueTargetURLs: number;
    matchedInventoryPosts: number;
    missingFromInventory: number;
    downloadedPosts: number;
    failedPosts: number;
    pendingPosts: number;
  };
  database: {
    exists: boolean;
    postRows: number;
    postRowsOutsideSelectedTargets: number;
    mediaRows: number;
    selectedMediaRows: number;
    selectedMediaFilesPresent: number;
    selectedMediaFilesMissing: number;
  };
  expectedTargetAssets: Record<string, number>;
  downloadedTargetMedia: Record<string, number>;
  lists: {
    failedTargetPosts: HarvestReportPost[];
    pendingTargetPosts: HarvestReportPost[];
    targetURLsMissingFromInventory: string[];
    statusCacheEntriesWithLastErrors: string[];
    missingLocalMediaFiles: string[];
  };
};

const DEFAULT_INVENTORY_FILENAME = 'inventory.jsonl';
const DEFAULT_CURRENT_INVENTORY_FILENAME = 'inventory-current.jsonl';
const DEFAULT_TARGETS_FILENAME = 'targets.txt';
const DEFAULT_DB_FILENAME = 'db.sqlite';
const DEFAULT_TOP_COUNT = 20;

export async function harvestReport(options: {
  onOptionError: (error: unknown) => Promise<void>;
}): Promise<HarvestReportResult> {
  try {
    if (!CommandLineParser.harvestReport()) {
      return false;
    }
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  let cliOptions;
  try {
    cliOptions = getCLIOptions(true);
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  let inventoryInValue: string | undefined;
  let targetInValue: string | undefined;
  let dbInValue: string | undefined;
  let harvestReportOutValue: string | undefined;
  try {
    inventoryInValue = CommandLineParser.inventoryIn();
    targetInValue = CommandLineParser.targetIn();
    dbInValue = CommandLineParser.dbIn();
    harvestReportOutValue = CommandLineParser.harvestReportOut();
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  const outDir = path.resolve(cliOptions.outDir || process.cwd());
  const stateDir = path.join(outDir, '.patreon-dl');
  const inventoryIn = path.resolve(inventoryInValue || getDefaultInventoryPath(stateDir));
  const targetIn = path.resolve(targetInValue || path.join(stateDir, DEFAULT_TARGETS_FILENAME));
  const dbIn = path.resolve(dbInValue || path.join(stateDir, DEFAULT_DB_FILENAME));
  const harvestReportOut = harvestReportOutValue ? path.resolve(harvestReportOutValue) : null;

  try {
    const inventoryPosts = readInventoryPosts(inventoryIn);
    const targetURLs = readTargetURLs(targetIn);
    const dbState = readHarvestDB(dbIn);
    const statusCache = readStatusCaches(outDir);
    const report = createHarvestReport({
      outDir,
      inventoryIn,
      targetIn,
      dbIn,
      harvestReportOut,
      inventoryPosts,
      targetURLs,
      dbState,
      statusCache
    });
    printHarvestReport(report);
    if (harvestReportOut) {
      writeJSONAtomic(harvestReportOut, report);
      console.log(`\nHarvest report JSON written to "${harvestReportOut}"`);
    }
    updateArchiveState(outDir, (state) => {
      state.harvest = {
        ...state.harvest,
        lastReport: {
          path: harvestReportOut ? toArchiveStatePath(outDir, harvestReportOut) : null,
          generatedAt: report.generatedAt,
          inventory: toArchiveStatePath(outDir, inventoryIn) || inventoryIn,
          targets: toArchiveStatePath(outDir, targetIn) || targetIn,
          database: toArchiveStatePath(outDir, dbIn) || dbIn,
          counts: {
            targetURLs: report.targets.targetURLs,
            uniqueTargetURLs: report.targets.uniqueTargetURLs,
            matchedInventoryPosts: report.targets.matchedInventoryPosts,
            missingFromInventory: report.targets.missingFromInventory,
            downloadedPosts: report.targets.downloadedPosts,
            failedPosts: report.targets.failedPosts,
            pendingPosts: report.targets.pendingPosts,
            dbExists: report.database.exists,
            dbPostRows: report.database.postRows,
            dbMediaRows: report.database.mediaRows,
            selectedMediaFilesPresent: report.database.selectedMediaFilesPresent,
            selectedMediaFilesMissing: report.database.selectedMediaFilesMissing
          }
        }
      };
    });
  }
  catch (error) {
    console.error('Harvest report error:', error instanceof Error ? error.message : error);
    return { hasError: true };
  }

  return { hasError: false };
}

function getDefaultInventoryPath(stateDir: string) {
  const currentInventory = path.join(stateDir, DEFAULT_CURRENT_INVENTORY_FILENAME);
  if (fs.existsSync(currentInventory)) {
    return currentInventory;
  }
  return path.join(stateDir, DEFAULT_INVENTORY_FILENAME);
}

function readTargetURLs(file: string) {
  const content = fs.readFileSync(file, 'utf-8');
  return content.replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('http://') || line.startsWith('https://'));
}

function readHarvestDB(file: string): HarvestDBState {
  if (!fs.existsSync(file)) {
    return {
      exists: false,
      postsByID: new Map(),
      postsByURL: new Map(),
      mediaByPostID: new Map(),
      totalPosts: 0,
      totalMedia: 0
    };
  }

  const db = new Database(file, { readonly: true });
  try {
    const postRows = db.prepare(`
      SELECT
        content_id,
        json_extract(details, '$.url') AS url
      FROM content
      WHERE content_type = 'post'
    `).all() as DBPostRow[];
    const mediaRows = db.prepare(`
      SELECT
        cm.content_id,
        m.media_id,
        m.media_type,
        m.download_path,
        cm.is_preview
      FROM content_media cm
      JOIN media m ON m.media_id = cm.media_id
      WHERE cm.content_type = 'post'
    `).all() as DBMediaRow[];

    const mediaByPostID = new Map<string, DBMediaRow[]>();
    for (const row of mediaRows) {
      const rows = mediaByPostID.get(row.content_id) || [];
      rows.push(row);
      mediaByPostID.set(row.content_id, rows);
    }

    return {
      exists: true,
      postsByID: new Map(postRows.map((row) => [ row.content_id, row ])),
      postsByURL: new Map(postRows.filter((row) => !!row.url).map((row) => [ row.url as string, row ])),
      mediaByPostID,
      totalPosts: postRows.length,
      totalMedia: mediaRows.length
    };
  }
  finally {
    db.close();
  }
}

function readStatusCaches(outDir: string): StatusCacheState {
  const files = findStatusCacheFiles(outDir);
  const postsByID = new Map<string, StatusCachePostEntry>();
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { posts?: Record<string, StatusCachePostEntry>; };
    for (const [ postID, entry ] of Object.entries(data.posts || {})) {
      postsByID.set(entry.lastTargetInfo?.id || postID, entry);
    }
  }
  return {
    files,
    postsByID
  };
}

function findStatusCacheFiles(root: string) {
  const result: string[] = [];
  const stack: { dir: string; depth: number; }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > 8 || !fs.existsSync(current.dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name === 'status-cache.json' && path.basename(current.dir) === '.patreon-dl') {
        result.push(entryPath);
      }
      else if (entry.isDirectory() && entry.name !== 'node_modules') {
        stack.push({ dir: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return result.sort();
}

function createHarvestReport(args: {
  outDir: string;
  inventoryIn: string;
  targetIn: string;
  dbIn: string;
  harvestReportOut: string | null;
  inventoryPosts: InventoryPostRecord[];
  targetURLs: string[];
  dbState: HarvestDBState;
  statusCache: StatusCacheState;
}): HarvestReportData {
  const uniqueTargetURLs = Array.from(new Set(args.targetURLs));
  const inventoryByURL = new Map(args.inventoryPosts.filter((post) => !!post.url).map((post) => [ post.url as string, post ]));
  const targetPosts = uniqueTargetURLs
    .map((url) => ({ url, post: inventoryByURL.get(url) || null }))
    .filter((target): target is { url: string; post: InventoryPostRecord; } => !!target.post);
  const missingInventoryURLs = uniqueTargetURLs.filter((url) => !inventoryByURL.has(url));

  const downloadedTargets: InventoryPostRecord[] = [];
  const failedTargets: InventoryPostRecord[] = [];
  const pendingTargets: InventoryPostRecord[] = [];
  const missingLocalFiles: { post: InventoryPostRecord; media: DBMediaRow; file: string; }[] = [];
  const downloadedMediaCounts = new Map<string, number>();
  const expectedMediaCounts = getExpectedMediaCounts(targetPosts.map((target) => target.post));
  let selectedDBMedia = 0;
  let selectedMediaFilesPresent = 0;

  for (const { post } of targetPosts) {
    const postID = post.id || getPostIDFromURL(post.url);
    const dbPost = postID ? args.dbState.postsByID.get(postID) : null;
    const statusEntry = postID ? args.statusCache.postsByID.get(postID) : null;
    if (statusEntry?.lastDownloadHasErrors) {
      failedTargets.push(post);
    }
    else if (dbPost || (post.url && args.dbState.postsByURL.has(post.url))) {
      downloadedTargets.push(post);
    }
    else {
      pendingTargets.push(post);
    }

    if (!postID) {
      continue;
    }
    for (const media of args.dbState.mediaByPostID.get(postID) || []) {
      selectedDBMedia++;
      increment(downloadedMediaCounts, media.media_type || 'unknown');
      if (!media.download_path) {
        continue;
      }
      const mediaPath = path.resolve(args.outDir, media.download_path);
      if (fs.existsSync(mediaPath)) {
        selectedMediaFilesPresent++;
      }
      else {
        missingLocalFiles.push({ post, media, file: mediaPath });
      }
    }
  }

  const targetPostIDs = new Set(targetPosts.map((target) => target.post.id).filter((id): id is string => !!id));
  const dbPostsOutsideTargets = Array.from(args.dbState.postsByID.keys()).filter((postID) => !targetPostIDs.has(postID));
  const erroredCacheEntries = Array.from(args.statusCache.postsByID.entries()).filter(([, entry]) => !!entry.lastDownloadHasErrors);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    paths: {
      outDir: args.outDir,
      inventory: args.inventoryIn,
      targets: args.targetIn,
      database: args.dbIn,
      reportJSON: args.harvestReportOut
    },
    statusCaches: {
      files: args.statusCache.files,
      postEntries: args.statusCache.postsByID.size
    },
    targets: {
      targetURLs: args.targetURLs.length,
      uniqueTargetURLs: uniqueTargetURLs.length,
      matchedInventoryPosts: targetPosts.length,
      missingFromInventory: missingInventoryURLs.length,
      downloadedPosts: downloadedTargets.length,
      failedPosts: failedTargets.length,
      pendingPosts: pendingTargets.length
    },
    database: {
      exists: args.dbState.exists,
      postRows: args.dbState.totalPosts,
      postRowsOutsideSelectedTargets: dbPostsOutsideTargets.length,
      mediaRows: args.dbState.totalMedia,
      selectedMediaRows: selectedDBMedia,
      selectedMediaFilesPresent,
      selectedMediaFilesMissing: missingLocalFiles.length
    },
    expectedTargetAssets: mapToRecord(expectedMediaCounts),
    downloadedTargetMedia: mapToRecord(downloadedMediaCounts),
    lists: {
      failedTargetPosts: failedTargets.map(summarizePost),
      pendingTargetPosts: pendingTargets.map(summarizePost),
      targetURLsMissingFromInventory: missingInventoryURLs,
      statusCacheEntriesWithLastErrors: erroredCacheEntries.map(([ postID ]) => postID),
      missingLocalMediaFiles: missingLocalFiles.map(({ file }) => file)
    }
  };
}

function printHarvestReport(report: HarvestReportData) {
  printHeading('Harvest Report');
  console.log(`Inventory: ${report.paths.inventory}`);
  console.log(`Targets: ${report.paths.targets}`);
  console.log(`Database: ${report.paths.database}${report.database.exists ? '' : ' (missing)'}`);
  console.log(`Status caches: ${report.statusCaches.files.length} files, ${report.statusCaches.postEntries} post entries`);
  console.log(`Output directory: ${report.paths.outDir}`);

  printHeading('Target Coverage');
  console.log(`Target URLs: ${report.targets.targetURLs}`);
  console.log(`Unique target URLs: ${report.targets.uniqueTargetURLs}`);
  console.log(`Matched inventory posts: ${report.targets.matchedInventoryPosts}`);
  console.log(`Missing from inventory: ${report.targets.missingFromInventory}`);
  console.log(`Downloaded target posts: ${report.targets.downloadedPosts}`);
  console.log(`Failed target posts: ${report.targets.failedPosts}`);
  console.log(`Pending target posts: ${report.targets.pendingPosts}`);

  printHeading('Database Coverage');
  console.log(`DB post rows: ${report.database.postRows}`);
  console.log(`DB post rows outside selected targets: ${report.database.postRowsOutsideSelectedTargets}`);
  console.log(`DB media rows: ${report.database.mediaRows}`);
  console.log(`Selected DB media rows: ${report.database.selectedMediaRows}`);
  console.log(`Selected media files present: ${report.database.selectedMediaFilesPresent}`);
  console.log(`Selected media files missing: ${report.database.selectedMediaFilesMissing}`);

  printCounts('Expected target assets from inventory', recordToMap(report.expectedTargetAssets), CONTENT_MEDIA_TYPES);
  printCounts('Downloaded target media from DB', recordToMap(report.downloadedTargetMedia));

  printPostList('Failed target posts', report.lists.failedTargetPosts);
  printPostList('Pending target posts', report.lists.pendingTargetPosts);
  printStringList('Target URLs missing from inventory', report.lists.targetURLsMissingFromInventory);
  printStringList('Status-cache entries with last errors', report.lists.statusCacheEntriesWithLastErrors);
  printStringList('Missing local media files', report.lists.missingLocalMediaFiles);
}

function getExpectedMediaCounts(posts: InventoryPostRecord[]) {
  const counts = new Map<ContentMediaType, number>();
  for (const post of posts) {
    for (const media of post.media || []) {
      if (media.hasDownloadURL !== false) {
        for (const mediaType of getContentMediaTypes(media)) {
          increment(counts, mediaType);
        }
      }
    }
  }
  return counts;
}

function summarizePost(post: InventoryPostRecord): HarvestReportPost {
  return {
    id: post.id,
    url: post.url,
    title: post.title,
    publishedAt: post.publishedAt
  };
}

function mapToRecord(counts: Map<string, number>) {
  return Object.fromEntries(sortCounts(counts));
}

function recordToMap(record: Record<string, number>) {
  return new Map(Object.entries(record));
}

function getPostIDFromURL(url?: string | null) {
  if (!url) {
    return null;
  }
  const match = /-(\d+)(?:[/?#]|$)/.exec(url);
  return match?.[1] || null;
}

function printHeading(title: string) {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
}

function printCounts(title: string, counts: Map<string, number>, keys?: string[]) {
  printHeading(title);
  const entries = keys ? keys.map((key) => [ key, counts.get(key) || 0 ] as const) : sortCounts(counts);
  if (entries.length === 0) {
    console.log('(none)');
    return;
  }
  const keyWidth = Math.max(...entries.map(([ key ]) => key.length), 4);
  for (const [ key, count ] of entries) {
    console.log(`${key.padEnd(keyWidth)}  ${count}`);
  }
}

function printPostList(title: string, posts: HarvestReportPost[]) {
  printHeading(title);
  if (posts.length === 0) {
    console.log('(none)');
    return;
  }
  for (const post of posts.slice(0, DEFAULT_TOP_COUNT)) {
    console.log([ post.id, post.url, post.title ].filter((value) => !!value).join(' | '));
  }
  if (posts.length > DEFAULT_TOP_COUNT) {
    console.log(`... ${posts.length - DEFAULT_TOP_COUNT} more`);
  }
}

function printStringList(title: string, values: string[]) {
  printHeading(title);
  if (values.length === 0) {
    console.log('(none)');
    return;
  }
  for (const value of values.slice(0, DEFAULT_TOP_COUNT)) {
    console.log(value);
  }
  if (values.length > DEFAULT_TOP_COUNT) {
    console.log(`... ${values.length - DEFAULT_TOP_COUNT} more`);
  }
}

function sortCounts(counts: Map<string, number>) {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function increment(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) || 0) + 1);
}
