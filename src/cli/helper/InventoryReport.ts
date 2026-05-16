import fs from 'fs';
import path from 'path';
import { getCLIOptions } from '../CLIOptions.js';
import CommandLineParser from '../CommandLineParser.js';
import {
  CONTENT_MEDIA_TYPES,
  type ContentMediaType,
  getContentMediaTypes,
  type InventoryPostRecord
} from './InventorySelect.js';

export type InventoryReportResult = false | {
  hasError: boolean;
};

type InventoryRunRecord = {
  type?: string;
  startedAt?: string;
  limit?: number | null;
  targets?: string[];
  resumed?: boolean;
  existingPosts?: number;
  delta?: boolean;
  merge?: boolean;
  baseInventory?: string | null;
  deltaInventory?: string | null;
  basePosts?: number;
  deltaPosts?: number;
};

type InventorySummaryRecord = {
  type?: string;
  completedAt?: string;
  aborted?: boolean;
  limited?: boolean;
  limit?: number | null;
  totalPosts?: number;
  basePosts?: number;
  deltaPosts?: number;
  existingPosts?: number;
  newPosts?: number;
  updatedPosts?: number;
  unchangedDeltaPosts?: number;
  skippedExistingPosts?: number;
  resumed?: boolean;
  delta?: boolean;
  merge?: boolean;
  stopReason?: string;
};

type InventoryRecords = {
  runs: InventoryRunRecord[];
  summaries: InventorySummaryRecord[];
  posts: InventoryPostRecord[];
};

const DEFAULT_INVENTORY_FILENAME = 'inventory.jsonl';
const DEFAULT_TOP_COUNT = 20;

export async function reportInventory(options: {
  onOptionError: (error: unknown) => Promise<void>;
}): Promise<InventoryReportResult> {
  try {
    if (!CommandLineParser.inventoryReport()) {
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
  try {
    inventoryInValue = CommandLineParser.inventoryIn();
    targetInValue = CommandLineParser.targetIn();
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  const outDir = path.resolve(cliOptions.outDir || process.cwd());
  const inventoryIn = path.resolve(inventoryInValue || path.join(outDir, '.patreon-dl', DEFAULT_INVENTORY_FILENAME));
  const targetIn = targetInValue ? path.resolve(targetInValue) : null;

  try {
    const records = readInventoryRecords(inventoryIn);
    const targetURLs = targetIn ? readTargetURLs(targetIn) : null;
    printReport({ inventoryIn, targetIn, records, targetURLs });
  }
  catch (error) {
    console.error('Inventory report error:', error instanceof Error ? error.message : error);
    return { hasError: true };
  }

  return { hasError: false };
}

function readInventoryRecords(file: string): InventoryRecords {
  const content = fs.readFileSync(file, 'utf-8');
  const records: InventoryRecords = {
    runs: [],
    summaries: [],
    posts: []
  };
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let record: InventoryRunRecord | InventorySummaryRecord | InventoryPostRecord;
    try {
      record = JSON.parse(line);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Error(`Failed to parse inventory JSONL line ${i + 1}: ${message}`);
    }
    switch (record.type) {
      case 'inventoryRun':
        records.runs.push(record as InventoryRunRecord);
        break;
      case 'inventorySummary':
        records.summaries.push(record as InventorySummaryRecord);
        break;
      case 'post':
        records.posts.push(record as InventoryPostRecord);
        break;
    }
  }
  return records;
}

function readTargetURLs(file: string) {
  const content = fs.readFileSync(file, 'utf-8');
  return content.replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('http://') || line.startsWith('https://'));
}

function printReport(args: {
  inventoryIn: string;
  targetIn: string | null;
  records: InventoryRecords;
  targetURLs: string[] | null;
}) {
  const { inventoryIn, targetIn, records, targetURLs } = args;
  const latestRun = records.runs.at(-1);
  const latestSummary = records.summaries.at(-1);
  const inventoryStats = getPostStats(records.posts);

  printHeading('Inventory Report');
  console.log(`Inventory: ${inventoryIn}`);
  if (latestRun?.startedAt) {
    console.log(`Started: ${latestRun.startedAt}`);
  }
  if (latestSummary?.completedAt) {
    console.log(`Completed: ${latestSummary.completedAt}`);
  }
  if (latestRun?.delta || latestSummary?.delta) {
    console.log('Mode: delta');
  }
  if (latestRun?.merge || latestSummary?.merge) {
    console.log('Mode: merge');
  }
  console.log(`Posts: ${records.posts.length}`);
  if (latestRun?.resumed) {
    console.log(`Resume: existingPosts=${latestRun.existingPosts || 0}`);
  }
  if (latestSummary) {
    const summary = [
      `aborted=${!!latestSummary.aborted}`,
      `limited=${!!latestSummary.limited}`,
      `limit=${latestSummary.limit || 'none'}`
    ];
    if (latestSummary.newPosts !== undefined) {
      summary.push(`newPosts=${latestSummary.newPosts}`);
    }
    if (latestSummary.updatedPosts !== undefined) {
      summary.push(`updatedPosts=${latestSummary.updatedPosts}`);
    }
    if (latestSummary.deltaPosts !== undefined) {
      summary.push(`deltaPosts=${latestSummary.deltaPosts}`);
    }
    if (latestSummary.basePosts !== undefined) {
      summary.push(`basePosts=${latestSummary.basePosts}`);
    }
    if (latestSummary.skippedExistingPosts !== undefined) {
      summary.push(`skippedExistingPosts=${latestSummary.skippedExistingPosts}`);
    }
    if (latestSummary.unchangedDeltaPosts !== undefined) {
      summary.push(`unchangedDeltaPosts=${latestSummary.unchangedDeltaPosts}`);
    }
    if (latestSummary.stopReason) {
      summary.push(`stopReason=${latestSummary.stopReason}`);
    }
    console.log(`Summary: ${summary.join('; ')}`);
  }

  printCounts('Posts by content media', inventoryStats.postsByMediaType, CONTENT_MEDIA_TYPES);
  printCounts('Assets by content media', inventoryStats.assetsByMediaType, CONTENT_MEDIA_TYPES);
  printCounts('Assets by source', inventoryStats.assetsBySource);
  printCounts('Top tags', inventoryStats.tagCounts, undefined, DEFAULT_TOP_COUNT);

  if (!targetURLs) {
    return;
  }

  const targetStats = getTargetStats(records.posts, targetURLs);
  printHeading('Target Report');
  console.log(`Targets: ${targetIn}`);
  console.log(`Target URLs: ${targetURLs.length}`);
  console.log(`Unique target URLs: ${new Set(targetURLs).size}`);
  console.log(`Matched inventory posts: ${targetStats.matchedPosts.length}`);
  console.log(`Missing from inventory: ${targetStats.missingURLs.length}`);
  printCounts('Target posts by content media', targetStats.postStats.postsByMediaType, CONTENT_MEDIA_TYPES);
  printCounts('Target assets by content media', targetStats.postStats.assetsByMediaType, CONTENT_MEDIA_TYPES);
  printCounts('Top target tags', targetStats.postStats.tagCounts, undefined, DEFAULT_TOP_COUNT);
  if (targetStats.missingURLs.length > 0) {
    printHeading('Missing Target URLs');
    targetStats.missingURLs.slice(0, DEFAULT_TOP_COUNT).forEach((url) => console.log(url));
    if (targetStats.missingURLs.length > DEFAULT_TOP_COUNT) {
      console.log(`... ${targetStats.missingURLs.length - DEFAULT_TOP_COUNT} more`);
    }
  }
}

function getTargetStats(posts: InventoryPostRecord[], targetURLs: string[]) {
  const postsByURL = new Map(posts.filter((post) => !!post.url).map((post) => [ post.url as string, post ]));
  const matchedPosts: InventoryPostRecord[] = [];
  const missingURLs: string[] = [];
  const seenURLs = new Set<string>();
  for (const url of targetURLs) {
    if (seenURLs.has(url)) {
      continue;
    }
    seenURLs.add(url);
    const post = postsByURL.get(url);
    if (post) {
      matchedPosts.push(post);
    }
    else {
      missingURLs.push(url);
    }
  }
  return {
    matchedPosts,
    missingURLs,
    postStats: getPostStats(matchedPosts)
  };
}

function getPostStats(posts: InventoryPostRecord[]) {
  const postsByMediaType = new Map<string, number>();
  const assetsByMediaType = new Map<string, number>();
  const assetsBySource = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  for (const post of posts) {
    const postMediaTypes = new Set<ContentMediaType>();
    for (const media of post.media || []) {
      increment(assetsBySource, media.source || 'unknown');
      if (media.hasDownloadURL !== false) {
        for (const contentMediaType of getContentMediaTypes(media)) {
          postMediaTypes.add(contentMediaType);
          increment(assetsByMediaType, contentMediaType);
        }
      }
    }
    for (const mediaType of postMediaTypes) {
      increment(postsByMediaType, mediaType);
    }
    const postTags = new Set((post.tags || [])
      .map((tag) => tag.value || tag.id)
      .filter((tag): tag is string => !!tag));
    for (const tag of postTags) {
      increment(tagCounts, tag);
    }
  }

  return {
    postsByMediaType,
    assetsByMediaType,
    assetsBySource,
    tagCounts
  };
}

function printHeading(title: string) {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
}

function printCounts(title: string, counts: Map<string, number>, keys?: string[], limit?: number) {
  printHeading(title);
  const entries = keys ? keys.map((key) => [ key, counts.get(key) || 0 ] as const) : sortCounts(counts).slice(0, limit);
  if (entries.length === 0) {
    console.log('(none)');
    return;
  }
  const keyWidth = Math.max(...entries.map(([ key ]) => key.length), 4);
  for (const [ key, count ] of entries) {
    console.log(`${key.padEnd(keyWidth)}  ${count}`);
  }
}

function sortCounts(counts: Map<string, number>) {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function increment(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) || 0) + 1);
}
