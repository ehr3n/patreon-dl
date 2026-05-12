import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getCLIOptions } from '../CLIOptions.js';
import CommandLineParser from '../CommandLineParser.js';
import {
  CONTENT_MEDIA_TYPES,
  getContentMediaType,
  readInventoryPosts,
  type ContentMediaType,
  type InventoryPostRecord
} from './InventorySelect.js';

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
  try {
    inventoryInValue = CommandLineParser.inventoryIn();
    targetInValue = CommandLineParser.targetIn();
    dbInValue = CommandLineParser.dbIn();
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

  try {
    const inventoryPosts = readInventoryPosts(inventoryIn);
    const targetURLs = readTargetURLs(targetIn);
    const dbState = readHarvestDB(dbIn);
    const statusCache = readStatusCaches(outDir);
    printHarvestReport({
      outDir,
      inventoryIn,
      targetIn,
      dbIn,
      inventoryPosts,
      targetURLs,
      dbState,
      statusCache
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

function printHarvestReport(args: {
  outDir: string;
  inventoryIn: string;
  targetIn: string;
  dbIn: string;
  inventoryPosts: InventoryPostRecord[];
  targetURLs: string[];
  dbState: HarvestDBState;
  statusCache: StatusCacheState;
}) {
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

  printHeading('Harvest Report');
  console.log(`Inventory: ${args.inventoryIn}`);
  console.log(`Targets: ${args.targetIn}`);
  console.log(`Database: ${args.dbIn}${args.dbState.exists ? '' : ' (missing)'}`);
  console.log(`Status caches: ${args.statusCache.files.length} files, ${args.statusCache.postsByID.size} post entries`);
  console.log(`Output directory: ${args.outDir}`);

  printHeading('Target Coverage');
  console.log(`Target URLs: ${args.targetURLs.length}`);
  console.log(`Unique target URLs: ${uniqueTargetURLs.length}`);
  console.log(`Matched inventory posts: ${targetPosts.length}`);
  console.log(`Missing from inventory: ${missingInventoryURLs.length}`);
  console.log(`Downloaded target posts: ${downloadedTargets.length}`);
  console.log(`Failed target posts: ${failedTargets.length}`);
  console.log(`Pending target posts: ${pendingTargets.length}`);

  printHeading('Database Coverage');
  console.log(`DB post rows: ${args.dbState.totalPosts}`);
  console.log(`DB post rows outside selected targets: ${dbPostsOutsideTargets.length}`);
  console.log(`DB media rows: ${args.dbState.totalMedia}`);
  console.log(`Selected DB media rows: ${selectedDBMedia}`);
  console.log(`Selected media files present: ${selectedMediaFilesPresent}`);
  console.log(`Selected media files missing: ${missingLocalFiles.length}`);

  printCounts('Expected target assets from inventory', expectedMediaCounts, CONTENT_MEDIA_TYPES);
  printCounts('Downloaded target media from DB', downloadedMediaCounts);

  printPostList('Failed target posts', failedTargets);
  printPostList('Pending target posts', pendingTargets);
  printStringList('Target URLs missing from inventory', missingInventoryURLs);
  printStringList('Status-cache entries with last errors', erroredCacheEntries.map(([ postID ]) => postID));
  printStringList('Missing local media files', missingLocalFiles.map(({ file }) => file));
}

function getExpectedMediaCounts(posts: InventoryPostRecord[]) {
  const counts = new Map<ContentMediaType, number>();
  for (const post of posts) {
    for (const media of post.media || []) {
      const mediaType = getContentMediaType(media);
      if (mediaType && media.hasDownloadURL !== false) {
        increment(counts, mediaType);
      }
    }
  }
  return counts;
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

function printPostList(title: string, posts: InventoryPostRecord[]) {
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
