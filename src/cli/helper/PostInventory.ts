import fs from 'fs';
import path from 'path';
import { once } from 'events';
import Downloader from '../../downloaders/Downloader.js';
import PostsFetcher from '../../downloaders/PostsFetcher.js';
import ConsoleLogger from '../../utils/logging/ConsoleLogger.js';
import { commonLog } from '../../utils/logging/Logger.js';
import { getCLIOptions } from '../CLIOptions.js';
import CommandLineParser from '../CommandLineParser.js';
import type { Downloadable } from '../../entities/Downloadable.js';
import type { MediaItem } from '../../entities/MediaItem.js';
import type { Collection, Post, PostEmbed } from '../../entities/Post.js';
import Sleeper from '../../utils/Sleeper.js';

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

export async function inventoryPosts(options: {
  onOptionError: (error: unknown) => Promise<void>;
}): Promise<InventoryPostsResult> {
  let inventoryOut: string | undefined;
  try {
    if (!CommandLineParser.inventory()) {
      return false;
    }
    inventoryOut = CommandLineParser.inventoryOut();
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
  let totalPosts = 0;
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
        outputPath = inventoryOut || path.resolve(config.outDir, '.patreon-dl', 'inventory.jsonl');
        output = openInventoryOutput(outputPath);
        await writeJSONL(output, {
          type: 'inventoryRun',
          schemaVersion: 1,
          startedAt,
          targets: cliOptions.targetURLs.map((t) => t.url)
        });
      }

      const postsFetcher = new PostsFetcher({
        config,
        fetcher: downloader.getFetcher(),
        logger: warnLogger,
        signal: abortController.signal
      });

      commonLog(consoleLogger, 'info', null, `Inventory target: ${target.url}`);
      postsFetcher.begin();
      let targetPostCount = 0;
      let pageCount = 0;
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
        for (const post of list.items) {
          await writeJSONL(output, createPostInventoryRecord(post, target.url));
          targetPostCount++;
          totalPosts++;
        }
        commonLog(consoleLogger, 'info', null, `Inventoried posts: ${targetPostCount} / ${list.total ?? '?'}`);
        if (postsFetcher.hasNext() && config.request.pageDelay > 0) {
          commonLog(consoleLogger, 'info', null, `Waiting ${config.request.pageDelay / 1000} seconds before next inventory page`);
          await Sleeper.getInstance(config.request.pageDelay, abortController.signal).start();
        }
      }
      commonLog(consoleLogger, 'info', null, `Inventory target complete: ${targetPostCount} posts across ${pageCount} pages`);
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
      await writeJSONL(inventoryOutput, {
        type: 'inventorySummary',
        schemaVersion: 1,
        startedAt,
        completedAt: new Date().toISOString(),
        aborted: abortController.signal.aborted,
        totalPosts
      });
      await new Promise<void>((resolve) => inventoryOutput.end(resolve));
      if (outputPath) {
        commonLog(consoleLogger, 'info', null, `Inventory written to "${outputPath}"`);
      }
    }
    process.off('SIGINT', abortHandler);
  }

  return { hasError };
}

function openInventoryOutput(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.createWriteStream(file, { encoding: 'utf-8', flags: 'w' });
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
