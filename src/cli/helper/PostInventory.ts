import fs from 'fs';
import path from 'path';
import { once } from 'events';
import Downloader from '../../downloaders/Downloader.js';
import PostsFetcher, { SILENT_ABORT_REASON } from '../../downloaders/PostsFetcher.js';
import ConsoleLogger from '../../utils/logging/ConsoleLogger.js';
import { commonLog } from '../../utils/logging/Logger.js';
import { getCLIOptions } from '../CLIOptions.js';
import CommandLineParser from '../CommandLineParser.js';
import type { Downloadable } from '../../entities/Downloadable.js';
import type { MediaItem } from '../../entities/MediaItem.js';
import type { Collection, Post, PostEmbed } from '../../entities/Post.js';
import Sleeper from '../../utils/Sleeper.js';
import type { InventoryPostRecord } from './InventorySelect.js';
import { toArchiveStatePath, updateArchiveState } from './ArchiveState.js';

export type InventoryPostsResult = false | {
  hasError: boolean;
};

type InventoryMedia = {
  source: string;
  type: string;
  id: string;
  filename: string | null;
  mimeType: string | null;
  isPreview: boolean;
  hasDownloadURL: boolean;
};

type InventoryCheckpointRecord = {
  type?: string;
  targetURL?: string | null;
  nextURL?: string | null;
  complete?: boolean;
  checkpointedAt?: string;
  pageCount?: number;
  totalPosts?: number;
  newPosts?: number;
  skippedExistingPosts?: number;
  updatedPosts?: number;
  deltaPosts?: number;
  stopReason?: string;
};

type InventoryResumeState = {
  postKeys: Set<string>;
  postKeysByTargetURL: Map<string, Set<string>>;
  checkpointsByTargetURL: Map<string, InventoryCheckpointRecord>;
  recoveredTrailingRecord: boolean;
};

type InventoryBaseState = {
  postKeys: Set<string>;
  postsByKey: Map<string, InventoryPostRecord>;
};

const DEFAULT_INVENTORY_FILENAME = 'inventory.jsonl';
const DEFAULT_DELTA_INVENTORY_FILENAME = 'inventory-delta.jsonl';

export async function inventoryPosts(options: {
  onOptionError: (error: unknown) => Promise<void>;
}): Promise<InventoryPostsResult> {
  let inventory = false;
  let inventoryDelta = false;
  try {
    inventory = CommandLineParser.inventory();
    inventoryDelta = CommandLineParser.inventoryDelta();
    if (!inventory && !inventoryDelta) {
      return false;
    }
    if (inventory && inventoryDelta) {
      throw Error("'--inventory' and '--inventory-delta' cannot be used together");
    }
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  if (inventoryDelta) {
    return inventoryDeltaPosts(options);
  }

  return inventoryAllPosts(options);
}

async function inventoryAllPosts(options: {
  onOptionError: (error: unknown) => Promise<void>;
}): Promise<InventoryPostsResult> {
  let inventoryOut: string | undefined;
  let inventoryLimit: number | undefined;
  let inventoryResume = false;
  try {
    inventoryOut = CommandLineParser.inventoryOut();
    inventoryLimit = parseInventoryLimit(CommandLineParser.inventoryLimit());
    inventoryResume = CommandLineParser.inventoryResume();
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  let cliOptions;
  try {
    cliOptions = getCLIOptions();
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  const consoleLogger = new ConsoleLogger(cliOptions.consoleLogger);
  const warnLogger = new ConsoleLogger({ logLevel: 'warn' });
  const abortController = new AbortController();
  const abortHandler = () => {
    console.log('Abort');
    abortController.abort();
  };
  process.on('SIGINT', abortHandler);

  let hasError = false;
  let output: fs.WriteStream | null = null;
  let outputPath: string | null = null;
  let stateOutDir: string | null = null;
  let resumeState: InventoryResumeState | null = null;
  let initialExistingPosts = 0;
  let totalPosts = 0;
  let newPosts = 0;
  let skippedExistingPosts = 0;
  let hitLimit = false;
  const startedAt = new Date().toISOString();

  try {
    for (const target of cliOptions.targetURLs) {
      const downloader = await Downloader.getInstance(target.url, {
        ...cliOptions,
        include: {
          ...cliOptions.include,
          ...(target.include || {})
        }
      });
      const PostDownloader = (await import('../../downloaders/PostDownloader.js')).default;
      if (!(downloader instanceof PostDownloader)) {
        throw Error('Inventory mode supports post targets only');
      }

      const config = downloader.getConfig(false);
      if (!output) {
        outputPath = inventoryOut || path.resolve(config.outDir, '.patreon-dl', DEFAULT_INVENTORY_FILENAME);
        stateOutDir = config.outDir;
        if (inventoryResume) {
          const recoveredTrailingRecord = recoverTrailingInventoryRecord(outputPath);
          resumeState = readInventoryResumeState(outputPath);
          resumeState.recoveredTrailingRecord = recoveredTrailingRecord;
          initialExistingPosts = resumeState.postKeys.size;
          totalPosts = initialExistingPosts;
          if (resumeState.recoveredTrailingRecord) {
            commonLog(consoleLogger, 'warn', null, 'Recovered inventory checkpoint by removing an incomplete trailing JSONL record');
          }
          if (initialExistingPosts > 0) {
            commonLog(consoleLogger, 'info', null, `Inventory resume checkpoint: ${initialExistingPosts} existing posts`);
          }
        }
        else {
          resumeState = createEmptyResumeState();
        }
        output = openInventoryOutput(outputPath, inventoryResume);
        await writeJSONL(output, {
          type: 'inventoryRun',
          schemaVersion: 1,
          startedAt,
          limit: inventoryLimit || null,
          resumed: inventoryResume,
          existingPosts: initialExistingPosts,
          targets: cliOptions.targetURLs.map((t) => t.url)
        });
      }

      if (!resumeState) {
        resumeState = createEmptyResumeState();
      }
      if (inventoryLimit && totalPosts >= inventoryLimit) {
        hitLimit = true;
        commonLog(consoleLogger, 'info', null, `Inventory limit already satisfied by checkpoint: ${totalPosts} posts`);
        break;
      }

      const targetCheckpoint = inventoryResume ? resumeState.checkpointsByTargetURL.get(target.url) : undefined;
      if (targetCheckpoint?.complete) {
        commonLog(consoleLogger, 'info', null, `Inventory target already complete in checkpoint: ${target.url}`);
        continue;
      }
      const resumeAPIURL = inventoryResume ? targetCheckpoint?.nextURL || undefined : undefined;
      const postsFetcher = new PostsFetcher({
        config,
        fetcher: downloader.getFetcher(),
        logger: warnLogger,
        signal: abortController.signal,
        initialPostsAPIURL: resumeAPIURL
      });

      commonLog(consoleLogger, 'info', null, `Inventory target: ${target.url}`);
      if (resumeAPIURL) {
        commonLog(consoleLogger, 'info', null, `Resuming inventory target from checkpoint: ${targetCheckpoint?.totalPosts ?? totalPosts} posts`);
      }
      postsFetcher.begin();
      let targetPostCount = 0;
      let targetSkippedExistingPosts = 0;
      let pageCount = 0;
      const targetPostKeys = getTargetPostKeys(resumeState, target.url);
      while (postsFetcher.hasNext()) {
        const { list, aborted, error } = await postsFetcher.next();
        if (aborted || abortController.signal.aborted) {
          break;
        }
        if (!list) {
          if (error) {
            commonLog(consoleLogger, 'error', null, 'Error fetching inventory:', error);
            hasError = true;
          }
          break;
        }
        pageCount++;
        let pageFullyProcessed = true;
        for (const post of list.items) {
          if (inventoryLimit && totalPosts >= inventoryLimit) {
            hitLimit = true;
            pageFullyProcessed = false;
            break;
          }
          const postKey = getPostCheckpointKey(post);
          if (postKey && resumeState.postKeys.has(postKey)) {
            targetSkippedExistingPosts++;
            skippedExistingPosts++;
            targetPostKeys.add(postKey);
            continue;
          }
          await writeJSONL(output, createPostInventoryRecord(post, target.url));
          if (postKey) {
            resumeState.postKeys.add(postKey);
            targetPostKeys.add(postKey);
          }
          targetPostCount++;
          newPosts++;
          totalPosts++;
        }
        if (pageFullyProcessed) {
          const checkpoint = {
            type: 'inventoryCheckpoint',
            schemaVersion: 1,
            targetURL: target.url,
            checkpointedAt: new Date().toISOString(),
            pageCount,
            totalPosts,
            newPosts,
            skippedExistingPosts,
            nextURL: list.nextURL,
            complete: !list.nextURL
          };
          await writeJSONL(output, checkpoint);
          resumeState.checkpointsByTargetURL.set(target.url, checkpoint);
        }
        commonLog(consoleLogger, 'info', null, `Inventoried posts: ${targetPostKeys.size} / ${list.total ?? '?'}`);
        if (inventoryLimit && totalPosts >= inventoryLimit) {
          hitLimit = true;
          commonLog(consoleLogger, 'info', null, `Inventory limit reached: ${totalPosts} posts`);
          abortController.abort(SILENT_ABORT_REASON);
          break;
        }
        if (postsFetcher.hasNext() && config.request.pageDelay > 0) {
          commonLog(consoleLogger, 'info', null, `Waiting ${config.request.pageDelay / 1000} seconds before next inventory page`);
          await Sleeper.getInstance(config.request.pageDelay, abortController.signal).start();
        }
      }
      commonLog(consoleLogger, 'info', null, `Inventory target complete: ${targetPostCount} new posts, ${targetSkippedExistingPosts} existing posts skipped across ${pageCount} pages`);
      if (hitLimit) {
        break;
      }
    }
  }
  catch (error) {
    if (!abortController.signal.aborted) {
      commonLog(consoleLogger, 'error', null, 'Inventory error:', error);
      hasError = true;
    }
  }
  finally {
    if (output) {
      const inventoryOutput = output;
      const completedAt = new Date().toISOString();
      const summary = {
        type: 'inventorySummary',
        schemaVersion: 1,
        startedAt,
        completedAt,
        aborted: abortController.signal.aborted && !hitLimit,
        limited: hitLimit,
        limit: inventoryLimit || null,
        totalPosts,
        existingPosts: initialExistingPosts,
        newPosts,
        skippedExistingPosts,
        resumed: inventoryResume
      };
      await writeJSONL(inventoryOutput, summary);
      await new Promise<void>((resolve) => inventoryOutput.end(resolve));
      if (outputPath) {
        commonLog(consoleLogger, 'info', null, `Inventory written to "${outputPath}"`);
      }
      if (outputPath && stateOutDir) {
        const archiveOutDir = stateOutDir;
        const archiveOutputPath = outputPath;
        updateArchiveState(stateOutDir, (state) => {
          state.inventory = {
            ...state.inventory,
            lastFull: {
              path: toArchiveStatePath(archiveOutDir, archiveOutputPath) || archiveOutputPath,
              startedAt,
              completedAt,
              totalPosts,
              newPosts,
              skippedExistingPosts,
              aborted: summary.aborted,
              limited: hitLimit,
              limit: inventoryLimit || null
            }
          };
        });
      }
    }
    process.off('SIGINT', abortHandler);
  }

  return { hasError };
}

async function inventoryDeltaPosts(options: {
  onOptionError: (error: unknown) => Promise<void>;
}): Promise<InventoryPostsResult> {
  let inventoryOut: string | undefined;
  let inventoryIn: string | undefined;
  let inventoryLimit: number | undefined;
  try {
    inventoryOut = CommandLineParser.inventoryOut();
    inventoryIn = CommandLineParser.inventoryIn();
    inventoryLimit = parseInventoryLimit(CommandLineParser.inventoryLimit());
    if (CommandLineParser.inventoryResume()) {
      throw Error("'--inventory-resume' cannot be used with '--inventory-delta'");
    }
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  let cliOptions;
  try {
    cliOptions = getCLIOptions();
  }
  catch (error) {
    await options.onOptionError(error);
    return { hasError: true };
  }

  const consoleLogger = new ConsoleLogger(cliOptions.consoleLogger);
  const warnLogger = new ConsoleLogger({ logLevel: 'warn' });
  const abortController = new AbortController();
  const abortHandler = () => {
    console.log('Abort');
    abortController.abort();
  };
  process.on('SIGINT', abortHandler);

  let hasError = false;
  let output: fs.WriteStream | null = null;
  let outputPath: string | null = null;
  let stateOutDir: string | null = null;
  let baseInventoryPath: string | null = null;
  let baseState: InventoryBaseState | null = null;
  let newPosts = 0;
  let updatedPosts = 0;
  let skippedExistingPosts = 0;
  let deltaPosts = 0;
  let hitLimit = false;
  let stopReason = 'end';
  const startedAt = new Date().toISOString();

  try {
    for (const target of cliOptions.targetURLs) {
      const downloader = await Downloader.getInstance(target.url, {
        ...cliOptions,
        include: {
          ...cliOptions.include,
          ...(target.include || {})
        }
      });
      const PostDownloader = (await import('../../downloaders/PostDownloader.js')).default;
      if (!(downloader instanceof PostDownloader)) {
        throw Error('Inventory delta mode supports post targets only');
      }

      const config = downloader.getConfig(false);
      if (!output) {
        baseInventoryPath = path.resolve(inventoryIn || path.join(config.outDir, '.patreon-dl', DEFAULT_INVENTORY_FILENAME));
        baseState = readInventoryBaseState(baseInventoryPath);
        outputPath = path.resolve(inventoryOut || path.join(config.outDir, '.patreon-dl', DEFAULT_DELTA_INVENTORY_FILENAME));
        stateOutDir = config.outDir;
        output = openInventoryOutput(outputPath, false);
        await writeJSONL(output, {
          type: 'inventoryRun',
          schemaVersion: 1,
          delta: true,
          startedAt,
          limit: inventoryLimit || null,
          baseInventory: baseInventoryPath,
          basePosts: baseState.postKeys.size,
          targets: cliOptions.targetURLs.map((t) => t.url)
        });
        commonLog(consoleLogger, 'info', null, `Inventory delta base: ${baseState.postKeys.size} posts from "${baseInventoryPath}"`);
      }

      if (!baseState || !output) {
        throw Error('Inventory delta output was not initialized');
      }
      if (inventoryLimit && deltaPosts >= inventoryLimit) {
        hitLimit = true;
        stopReason = 'limit';
        commonLog(consoleLogger, 'info', null, `Inventory delta limit already satisfied: ${deltaPosts} records`);
        break;
      }

      const postsFetcher = new PostsFetcher({
        config,
        fetcher: downloader.getFetcher(),
        logger: warnLogger,
        signal: abortController.signal
      });

      commonLog(consoleLogger, 'info', null, `Inventory delta target: ${target.url}`);
      postsFetcher.begin();
      let pageCount = 0;
      let targetNewPosts = 0;
      let targetUpdatedPosts = 0;
      let targetSkippedExistingPosts = 0;
      let targetStopReason = 'end';
      while (postsFetcher.hasNext()) {
        const { list, aborted, error } = await postsFetcher.next();
        if (aborted || abortController.signal.aborted) {
          targetStopReason = 'abort';
          break;
        }
        if (!list) {
          if (error) {
            commonLog(consoleLogger, 'error', null, 'Error fetching inventory delta:', error);
            hasError = true;
            targetStopReason = 'error';
            stopReason = 'error';
          }
          break;
        }
        pageCount++;
        let pageHadKnownPost = false;
        for (const post of list.items) {
          if (inventoryLimit && deltaPosts >= inventoryLimit) {
            hitLimit = true;
            targetStopReason = 'limit';
            stopReason = 'limit';
            break;
          }
          const postKey = getPostCheckpointKey(post);
          const existingPost = postKey ? baseState.postsByKey.get(postKey) : null;
          if (existingPost) {
            pageHadKnownPost = true;
            targetSkippedExistingPosts++;
            skippedExistingPosts++;
            if (isPostNewerThanInventoryRecord(post, existingPost)) {
              await writeJSONL(output, createPostInventoryRecord(post, target.url));
              targetUpdatedPosts++;
              updatedPosts++;
              deltaPosts++;
            }
            continue;
          }

          await writeJSONL(output, createPostInventoryRecord(post, target.url));
          targetNewPosts++;
          newPosts++;
          deltaPosts++;
        }

        await writeJSONL(output, {
          type: 'inventoryCheckpoint',
          schemaVersion: 1,
          delta: true,
          targetURL: target.url,
          checkpointedAt: new Date().toISOString(),
          pageCount,
          deltaPosts,
          newPosts,
          updatedPosts,
          skippedExistingPosts,
          nextURL: list.nextURL,
          complete: !list.nextURL || pageHadKnownPost || hitLimit,
          stopReason: pageHadKnownPost ? 'known-post' : targetStopReason
        });

        commonLog(consoleLogger, 'info', null, `Inventory delta page ${pageCount}: ${targetNewPosts} new, ${targetUpdatedPosts} updated, ${targetSkippedExistingPosts} known`);
        if (hitLimit) {
          commonLog(consoleLogger, 'info', null, `Inventory delta limit reached: ${deltaPosts} records`);
          break;
        }
        if (pageHadKnownPost) {
          targetStopReason = 'known-post';
          stopReason = stopReason === 'end' ? 'known-post' : stopReason;
          break;
        }
        if (postsFetcher.hasNext() && config.request.pageDelay > 0) {
          commonLog(consoleLogger, 'info', null, `Waiting ${config.request.pageDelay / 1000} seconds before next inventory page`);
          await Sleeper.getInstance(config.request.pageDelay, abortController.signal).start();
        }
      }
      commonLog(consoleLogger, 'info', null, `Inventory delta target complete: ${targetNewPosts} new posts, ${targetUpdatedPosts} updated posts, ${targetSkippedExistingPosts} known posts across ${pageCount} pages`);
      if (hitLimit) {
        break;
      }
    }
  }
  catch (error) {
    if (!abortController.signal.aborted) {
      commonLog(consoleLogger, 'error', null, 'Inventory delta error:', error);
      hasError = true;
      stopReason = 'error';
    }
  }
  finally {
    if (output) {
      const inventoryOutput = output;
      const completedAt = new Date().toISOString();
      const finalStopReason = abortController.signal.aborted && !hitLimit ? 'abort' : stopReason;
      const summary = {
        type: 'inventorySummary',
        schemaVersion: 1,
        delta: true,
        startedAt,
        completedAt,
        aborted: abortController.signal.aborted && !hitLimit,
        limited: hitLimit,
        limit: inventoryLimit || null,
        baseInventory: baseInventoryPath,
        basePosts: baseState?.postKeys.size || 0,
        deltaPosts,
        newPosts,
        updatedPosts,
        skippedExistingPosts,
        stopReason: finalStopReason
      };
      await writeJSONL(inventoryOutput, summary);
      await new Promise<void>((resolve) => inventoryOutput.end(resolve));
      if (outputPath) {
        commonLog(consoleLogger, 'info', null, `Inventory delta written to "${outputPath}"`);
      }
      if (outputPath && stateOutDir) {
        const archiveOutDir = stateOutDir;
        const archiveOutputPath = outputPath;
        const archiveBaseInventoryPath = baseInventoryPath;
        updateArchiveState(stateOutDir, (state) => {
          state.inventory = {
            ...state.inventory,
            lastDelta: {
              path: toArchiveStatePath(archiveOutDir, archiveOutputPath) || archiveOutputPath,
              baseInventory: toArchiveStatePath(archiveOutDir, archiveBaseInventoryPath),
              startedAt,
              completedAt,
              basePosts: baseState?.postKeys.size || 0,
              deltaPosts,
              newPosts,
              updatedPosts,
              skippedExistingPosts,
              stopReason: finalStopReason,
              aborted: summary.aborted,
              limited: hitLimit,
              limit: inventoryLimit || null
            }
          };
        });
      }
    }
    process.off('SIGINT', abortHandler);
  }

  return { hasError };
}

function readInventoryBaseState(file: string): InventoryBaseState {
  if (!fs.existsSync(file)) {
    throw Error(`Inventory input not found: "${file}"`);
  }
  const state: InventoryBaseState = {
    postKeys: new Set(),
    postsByKey: new Map()
  };
  const lines = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let record: InventoryPostRecord;
    try {
      record = JSON.parse(line);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Error(`Failed to parse inventory JSONL line ${i + 1}: ${message}`);
    }
    if (record.type !== 'post') {
      continue;
    }
    const postKey = getInventoryRecordCheckpointKey(record);
    if (!postKey) {
      continue;
    }
    state.postKeys.add(postKey);
    state.postsByKey.set(postKey, record);
  }
  return state;
}

function isPostNewerThanInventoryRecord(post: Post, record: InventoryPostRecord) {
  const postTimestamp = parseDateValue(post.editedAt) ?? parseDateValue(post.publishedAt);
  const recordTimestamp = parseDateValue(record.editedAt) ?? parseDateValue(record.publishedAt);
  return postTimestamp !== null && recordTimestamp !== null && postTimestamp > recordTimestamp;
}

function parseDateValue(value?: string | null) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function parseInventoryLimit(value?: number) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw Error("'--inventory-limit' must be a positive integer");
  }
  return value;
}

function createEmptyResumeState(): InventoryResumeState {
  return {
    postKeys: new Set(),
    postKeysByTargetURL: new Map(),
    checkpointsByTargetURL: new Map(),
    recoveredTrailingRecord: false
  };
}

function readInventoryResumeState(file: string) {
  const state = createEmptyResumeState();
  if (!fs.existsSync(file)) {
    return state;
  }
  const lines = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: any;
    try {
      record = JSON.parse(trimmed);
    }
    catch (_error: unknown) {
      continue;
    }
    if (record.type === 'post') {
      const postKey = getInventoryRecordCheckpointKey(record);
      if (postKey) {
        state.postKeys.add(postKey);
        if (record.targetURL) {
          getTargetPostKeys(state, record.targetURL).add(postKey);
        }
      }
    }
    else if (record.type === 'inventoryCheckpoint' && record.targetURL) {
      state.checkpointsByTargetURL.set(record.targetURL, record);
    }
  }
  return state;
}

function recoverTrailingInventoryRecord(file: string) {
  if (!fs.existsSync(file)) {
    return false;
  }
  const content = fs.readFileSync(file, 'utf-8');
  if (!content.trim()) {
    return false;
  }
  const lastLineStart = Math.max(content.lastIndexOf('\n', content.length - 2) + 1, 0);
  const lastLine = content.slice(lastLineStart).trim();
  if (!lastLine) {
    return false;
  }
  try {
    JSON.parse(lastLine);
    if (!content.endsWith('\n')) {
      fs.appendFileSync(file, '\n', 'utf-8');
    }
    return false;
  }
  catch (_error: unknown) {
    fs.truncateSync(file, lastLineStart);
    return true;
  }
}

function getTargetPostKeys(state: InventoryResumeState, targetURL: string) {
  let keys = state.postKeysByTargetURL.get(targetURL);
  if (!keys) {
    keys = new Set();
    state.postKeysByTargetURL.set(targetURL, keys);
  }
  return keys;
}

function getInventoryRecordCheckpointKey(record: { id?: string | null; url?: string | null; }) {
  if (record.id) {
    return `id:${record.id}`;
  }
  if (record.url) {
    return `url:${record.url}`;
  }
  return null;
}

function getPostCheckpointKey(post: Post) {
  return getInventoryRecordCheckpointKey(post);
}

function openInventoryOutput(file: string, append: boolean) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.createWriteStream(file, { encoding: 'utf-8', flags: append ? 'a' : 'w' });
}

async function writeJSONL(output: fs.WriteStream, data: unknown) {
  if (!output.write(`${JSON.stringify(data)}\n`)) {
    await once(output, 'drain');
  }
}

function createPostInventoryRecord(post: Post, targetURL: string) {
  const media = collectInventoryMedia(post);
  const mediaTypes = Array.from(new Set(media.map((m) => m.type))).sort();
  return {
    type: 'post',
    schemaVersion: 1,
    targetURL,
    id: post.id,
    url: post.url,
    title: post.title,
    postType: post.postType,
    isViewable: post.isViewable,
    publishedAt: post.publishedAt,
    editedAt: post.editedAt,
    commentCount: post.commentCount,
    content: post.content,
    contentText: post.contentText,
    teaserText: post.teaserText,
    tags: (post.tags || []).map((tag) => ({
      id: tag.id,
      value: tag.value
    })),
    collections: (post.collections || []).map(summarizeCollection),
    mediaSummary: {
      types: mediaTypes,
      countsByType: countBy(media, 'type'),
      countsBySource: countBy(media, 'source')
    },
    media
  };
}

function summarizeCollection(collection: Collection) {
  return {
    id: collection.id,
    title: collection.title,
    description: collection.description,
    createdAt: collection.createdAt,
    editedAt: collection.editedAt,
    numPosts: collection.numPosts
  };
}

function collectInventoryMedia(post: Post) {
  const media: InventoryMedia[] = [];
  addMedia(media, 'coverImage', post.coverImage);
  addMedia(media, 'thumbnail', post.thumbnail);
  addMedia(media, 'audio', post.audio);
  addMedia(media, 'audioPreview', post.audioPreview, true);
  addMedia(media, 'video', post.video);
  addMedia(media, 'videoPreview', post.videoPreview, true);
  addMedia(media, 'embed', post.embed);
  for (const image of post.images) {
    addMedia(media, 'images', image);
  }
  for (const attachment of post.attachments) {
    addMedia(media, 'attachments', attachment);
  }
  for (const linkedAttachment of post.linkedAttachments || []) {
    if (linkedAttachment.downloadable) {
      addMedia(media, 'linkedAttachments', linkedAttachment.downloadable);
    }
  }
  return media;
}

function addMedia(
  result: InventoryMedia[],
  source: string,
  item: Downloadable<MediaItem | PostEmbed> | null | undefined,
  isPreview = false
) {
  if (!item) {
    return;
  }
  result.push({
    source,
    type: item.type,
    id: item.id,
    filename: 'filename' in item ? item.filename : null,
    mimeType: 'mimeType' in item ? item.mimeType : null,
    isPreview,
    hasDownloadURL: hasDownloadURL(item)
  });
}

function hasDownloadURL(item: Downloadable<MediaItem | PostEmbed>) {
  const values = [
    'url' in item ? item.url : null,
    'downloadURL' in item ? item.downloadURL : null,
    'displayURL' in item ? item.displayURL : null,
    'thumbnailURL' in item ? item.thumbnailURL : null
  ];
  if ('imageURLs' in item) {
    values.push(...Object.values(item.imageURLs));
  }
  return values.some((value) => !!value);
}

function countBy(items: InventoryMedia[], prop: 'source' | 'type') {
  return items.reduce<Record<string, number>>((result, item) => {
    result[item[prop]] = (result[item[prop]] || 0) + 1;
    return result;
  }, {});
}
