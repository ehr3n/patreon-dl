import fs from 'fs';
import path from 'path';
import ConsoleLogger from '../../utils/logging/ConsoleLogger.js';
import { commonLog } from '../../utils/logging/Logger.js';
import { getCLIOptions } from '../CLIOptions.js';
import CommandLineParser from '../CommandLineParser.js';
import { readInventoryPosts, type InventoryPostRecord } from './InventorySelect.js';

export type InventoryMergeResult = false | {
  hasError: boolean;
};

type MergeStats = {
  basePosts: number;
  deltaPosts: number;
  newPosts: number;
  updatedPosts: number;
  unchangedDeltaPosts: number;
  totalPosts: number;
};

const DEFAULT_INVENTORY_FILENAME = 'inventory.jsonl';
const DEFAULT_DELTA_INVENTORY_FILENAME = 'inventory-delta.jsonl';
const DEFAULT_CURRENT_INVENTORY_FILENAME = 'inventory-current.jsonl';

export async function mergeInventory(options: {
  onOptionError: (error: unknown) => Promise<void>;
}): Promise<InventoryMergeResult> {
  try {
    if (!CommandLineParser.inventoryMerge()) {
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
  let deltaInValue: string | undefined;
  let inventoryOutValue: string | undefined;
  try {
    inventoryInValue = CommandLineParser.inventoryIn();
    deltaInValue = CommandLineParser.deltaIn();
    inventoryOutValue = CommandLineParser.inventoryOut();
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  const consoleLogger = new ConsoleLogger(cliOptions.consoleLogger);
  const outDir = path.resolve(cliOptions.outDir || process.cwd());
  const stateDir = path.join(outDir, '.patreon-dl');
  const inventoryIn = path.resolve(inventoryInValue || path.join(stateDir, DEFAULT_INVENTORY_FILENAME));
  const deltaIn = path.resolve(deltaInValue || path.join(stateDir, DEFAULT_DELTA_INVENTORY_FILENAME));
  const inventoryOut = path.resolve(inventoryOutValue || path.join(stateDir, DEFAULT_CURRENT_INVENTORY_FILENAME));

  try {
    const basePosts = readInventoryPosts(inventoryIn);
    const deltaPosts = readInventoryPosts(deltaIn);
    const { posts, stats } = mergeInventoryPosts(basePosts, deltaPosts);
    writeMergedInventory(inventoryOut, {
      inventoryIn,
      deltaIn,
      stats,
      posts
    });

    commonLog(consoleLogger, 'info', null, `Base inventory posts: ${stats.basePosts}`);
    commonLog(consoleLogger, 'info', null, `Delta inventory posts: ${stats.deltaPosts}`);
    commonLog(consoleLogger, 'info', null, `Merged inventory posts: ${stats.totalPosts} (${stats.newPosts} new, ${stats.updatedPosts} updated)`);
    commonLog(consoleLogger, 'info', null, `Merged inventory written to "${inventoryOut}"`);
  }
  catch (error) {
    commonLog(consoleLogger, 'error', null, 'Inventory merge error:', error);
    return { hasError: true };
  }

  return { hasError: false };
}

function mergeInventoryPosts(basePosts: InventoryPostRecord[], deltaPosts: InventoryPostRecord[]) {
  const postsByKey = new Map<string, InventoryPostRecord>();
  let newPosts = 0;
  let updatedPosts = 0;
  let unchangedDeltaPosts = 0;

  for (const post of basePosts) {
    const key = getPostKey(post);
    if (!key) {
      continue;
    }
    const existingPost = postsByKey.get(key);
    if (!existingPost || isInventoryRecordNewer(post, existingPost)) {
      postsByKey.set(key, post);
    }
  }

  for (const post of deltaPosts) {
    const key = getPostKey(post);
    if (!key) {
      continue;
    }
    const existingPost = postsByKey.get(key);
    if (!existingPost) {
      postsByKey.set(key, post);
      newPosts++;
      continue;
    }
    if (isInventoryRecordNewer(post, existingPost)) {
      postsByKey.set(key, post);
      updatedPosts++;
    }
    else {
      unchangedDeltaPosts++;
    }
  }

  const posts = Array.from(postsByKey.values()).sort(comparePostsByPublishedAt);
  return {
    posts,
    stats: {
      basePosts: basePosts.length,
      deltaPosts: deltaPosts.length,
      newPosts,
      updatedPosts,
      unchangedDeltaPosts,
      totalPosts: posts.length
    } satisfies MergeStats
  };
}

function writeMergedInventory(file: string, args: {
  inventoryIn: string;
  deltaIn: string;
  stats: MergeStats;
  posts: InventoryPostRecord[];
}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const records: unknown[] = [
    {
      type: 'inventoryRun',
      schemaVersion: 1,
      merge: true,
      startedAt,
      baseInventory: args.inventoryIn,
      deltaInventory: args.deltaIn,
      basePosts: args.stats.basePosts,
      deltaPosts: args.stats.deltaPosts
    },
    ...args.posts.map((post) => ({
      ...post,
      type: 'post',
      schemaVersion: post.schemaVersion || 1
    })),
    {
      type: 'inventorySummary',
      schemaVersion: 1,
      merge: true,
      startedAt,
      completedAt,
      baseInventory: args.inventoryIn,
      deltaInventory: args.deltaIn,
      basePosts: args.stats.basePosts,
      deltaPosts: args.stats.deltaPosts,
      newPosts: args.stats.newPosts,
      updatedPosts: args.stats.updatedPosts,
      unchangedDeltaPosts: args.stats.unchangedDeltaPosts,
      totalPosts: args.stats.totalPosts
    }
  ];
  const content = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, content, 'utf-8');
  fs.renameSync(tempFile, file);
}

function getPostKey(post: InventoryPostRecord) {
  if (post.id) {
    return `id:${post.id}`;
  }
  if (post.url) {
    return `url:${post.url}`;
  }
  return null;
}

function comparePostsByPublishedAt(a: InventoryPostRecord, b: InventoryPostRecord) {
  return compareDateDesc(a.publishedAt, b.publishedAt);
}

function isInventoryRecordNewer(a: InventoryPostRecord, b: InventoryPostRecord) {
  const aTimestamp = parseDateValue(a.editedAt) ?? parseDateValue(a.publishedAt);
  const bTimestamp = parseDateValue(b.editedAt) ?? parseDateValue(b.publishedAt);
  return aTimestamp !== null && bTimestamp !== null && aTimestamp > bTimestamp;
}

function compareDateDesc(a?: string | null, b?: string | null) {
  const aTimestamp = parseDateValue(a);
  const bTimestamp = parseDateValue(b);
  if (aTimestamp === null && bTimestamp === null) {
    return 0;
  }
  if (aTimestamp === null) {
    return 1;
  }
  if (bTimestamp === null) {
    return -1;
  }
  return bTimestamp - aTimestamp;
}

function parseDateValue(value?: string | null) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}
