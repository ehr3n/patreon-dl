import commandLineArgs from 'command-line-args';
import commandLineUsage from 'command-line-usage';
import { type CLIOptionParserEntry, type CLIOptions } from './CLIOptions.js';
import { EOL } from 'os';
import { type DeepPartial, type RecursivePropsTo } from '../utils/Misc.js';
import { getPackageInfo } from '../utils/PackageInfo.js';

export interface CommandLineParseResult extends RecursivePropsTo<DeepPartial<Omit<CLIOptions, 'targetURLs'>>, CLIOptionParserEntry> {
  targetURLs?: CLIOptionParserEntry;
  configFile?: CLIOptionParserEntry;
  debugAPI?: CLIOptionParserEntry;
}

const COMMAND_LINE_ARGS = {
  help: 'help',
  configureYouTube: 'configure-youtube',
  configFile: 'config-file',
  targetURL: 'target-url',
  cookie: 'cookie',
  ffmpeg: 'ffmpeg',
  deno: 'deno',
  outDir: 'out-dir',
  logLevel: 'log-level',
  noPrompt: 'no-prompt',
  dryRun: 'dry-run',
  force: 'force',
  listTiers: 'list-tiers',
  listTiersByUserId: 'list-tiers-uid',
  listPosts: 'list-posts',
  listPostsByUserId: 'list-posts-uid',
  inventory: 'inventory',
  inventoryDelta: 'inventory-delta',
  inventoryMerge: 'inventory-merge',
  inventoryOut: 'inventory-out',
  inventoryLimit: 'inventory-limit',
  inventoryResume: 'inventory-resume',
  inventoryReport: 'inventory-report',
  inventorySelect: 'inventory-select',
  inventoryIn: 'inventory-in',
  deltaIn: 'delta-in',
  harvestReport: 'harvest-report',
  dbIn: 'db-in',
  targetIn: 'target-in',
  targetOut: 'target-out',
  selectMedia: 'select-media',
  selectTag: 'select-tag',
  selectLimit: 'select-limit',
  debugAPI: 'debug-api'
} as const;

const OPT_DEFS = [
  {
    name: COMMAND_LINE_ARGS.help,
    description: 'Display this usage guide',
    alias: 'h',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.configFile,
    description: 'Load configuration file for setting full options',
    alias: 'C',
    type: String,
    typeLabel: '<file>'
  },
  {
    name: COMMAND_LINE_ARGS.targetURL,
    description: 'URL of content to download',
    type: String,
    defaultOption: true
  },
  {
    name: COMMAND_LINE_ARGS.cookie,
    description: 'Cookie for accessing patron-only content',
    alias: 'c',
    type: String,
    typeLabel: '<string>'
  },
  {
    name: COMMAND_LINE_ARGS.ffmpeg,
    description: 'Path to FFmpeg executable',
    alias: 'f',
    type: String,
    typeLabel: '<string>'
  },
  {
    name: COMMAND_LINE_ARGS.deno,
    description: 'Path to Deno executable',
    alias: 'd',
    type: String,
    typeLabel: '<string>'
  },
  {
    name: COMMAND_LINE_ARGS.outDir,
    description: 'Path to directory where content is saved',
    alias: 'o',
    type: String,
    typeLabel: '<dir>'
  },
  {
    name: COMMAND_LINE_ARGS.logLevel,
    description: 'Log level of the console logger: \'info\', \'debug\', \'warn\' or \'error\'; set to \'none\' to disable the logger.',
    alias: 'l',
    type: String,
    typeLabel: '<level>'
  },
  {
    name: COMMAND_LINE_ARGS.noPrompt,
    description: 'Do not prompt for confirmation to proceed',
    alias: 'y',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.dryRun,
    description: 'Run without writing files to disk (except logs, if any). For testing / debugging.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.force,
    description: 'Force target reprocessing by bypassing status-cache skips. Existing files still follow file-exists settings.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.listTiers,
    description: 'List tiers for the given creator(s). Separate multiple creators with a comma.',
    type: String,
    typeLabel: '<creator>'
  },
  {
    name: COMMAND_LINE_ARGS.listTiersByUserId,
    description: 'Same as \'--list-tiers\', but takes user ID instead of vanity.',
    type: String,
    typeLabel: '<user ID>'
  },
  {
    name: COMMAND_LINE_ARGS.listPosts,
    description: 'List posts by the given creator(s). Separate multiple creators with a comma.',
    type: String,
    typeLabel: '<creator>'
  },
  {
    name: COMMAND_LINE_ARGS.listPostsByUserId,
    description: 'Same as \'--list-posts\', but takes user ID instead of vanity.',
    type: String,
    typeLabel: '<user ID>'
  },
  {
    name: COMMAND_LINE_ARGS.inventory,
    description: 'Fetch post metadata inventory as JSONL without downloading media.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.inventoryDelta,
    description: 'Fetch newest post metadata until known posts from --inventory-in are reached, writing only new or updated records.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.inventoryMerge,
    description: 'Merge a base inventory JSONL and delta JSONL into a canonical current inventory.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.inventoryOut,
    description: 'Path to write inventory JSONL. Defaults depend on inventory mode.',
    type: String,
    typeLabel: '<file>'
  },
  {
    name: COMMAND_LINE_ARGS.inventoryLimit,
    description: 'Maximum total unique post records to inventory. With --inventory-resume, existing records count toward the limit.',
    type: Number,
    typeLabel: '<number>'
  },
  {
    name: COMMAND_LINE_ARGS.inventoryResume,
    description: 'Resume inventory from an existing JSONL checkpoint instead of overwriting it.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.inventoryReport,
    description: 'Read inventory JSONL and print a local summary report.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.inventorySelect,
    description: 'Read inventory JSONL and write a downloader targets file.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.harvestReport,
    description: 'Read inventory, targets, database, and status cache to report harvest coverage.',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.inventoryIn,
    description: 'Path to read inventory JSONL. Defaults to <out.dir>/.patreon-dl/inventory.jsonl.',
    type: String,
    typeLabel: '<file>'
  },
  {
    name: COMMAND_LINE_ARGS.deltaIn,
    description: 'Path to read delta inventory JSONL for --inventory-merge. Defaults to <out.dir>/.patreon-dl/inventory-delta.jsonl.',
    type: String,
    typeLabel: '<file>'
  },
  {
    name: COMMAND_LINE_ARGS.dbIn,
    description: 'Path to read downloader SQLite database. Defaults to <out.dir>/.patreon-dl/db.sqlite.',
    type: String,
    typeLabel: '<file>'
  },
  {
    name: COMMAND_LINE_ARGS.targetIn,
    description: 'Path to read selected target URLs for inventory report.',
    type: String,
    typeLabel: '<file>'
  },
  {
    name: COMMAND_LINE_ARGS.targetOut,
    description: 'Path to write selected target URLs. Defaults to <out.dir>/.patreon-dl/targets.txt.',
    type: String,
    typeLabel: '<file>'
  },
  {
    name: COMMAND_LINE_ARGS.selectMedia,
    description: 'Select posts with one or more content media types: image, video, audio, attachment.',
    type: String,
    typeLabel: '<types>'
  },
  {
    name: COMMAND_LINE_ARGS.selectTag,
    description: 'Select posts with one or more tag values or IDs. Separate multiple tags with commas.',
    type: String,
    typeLabel: '<tags>'
  },
  {
    name: COMMAND_LINE_ARGS.selectLimit,
    description: 'Maximum number of selected posts to write.',
    type: Number,
    typeLabel: '<number>'
  },
  {
    name: COMMAND_LINE_ARGS.configureYouTube,
    description: 'Configure YouTube connection',
    type: Boolean
  },
  {
    name: COMMAND_LINE_ARGS.debugAPI,
    description: 'Process target URL as local API data file ; internal - for debugging purposes.',
    type: Boolean
  }
];

export default class CommandLineParser {

  static parse(): CommandLineParseResult {
    const opts = this.#parseArgs();
    const argv = process.argv;

    const __getOptNameUsed = (key: string) => {
      const name = `--${key}`;
      if (argv.includes(name)) {
        return name;
      }
      const alias = OPT_DEFS.find((def) => def.name === key)?.alias;
      if (alias) {
        return `-${alias}`;
      }
      return name;
    };

    const __getValue = (key: typeof COMMAND_LINE_ARGS[keyof typeof COMMAND_LINE_ARGS]): CLIOptionParserEntry | undefined => {
      let value = opts[key];

      const booleanTypeArgs = [
        COMMAND_LINE_ARGS.noPrompt,
        COMMAND_LINE_ARGS.dryRun,
        COMMAND_LINE_ARGS.force,
        COMMAND_LINE_ARGS.inventory,
        COMMAND_LINE_ARGS.inventoryDelta,
        COMMAND_LINE_ARGS.inventoryMerge,
        COMMAND_LINE_ARGS.inventoryResume,
        COMMAND_LINE_ARGS.inventoryReport,
        COMMAND_LINE_ARGS.inventorySelect,
        COMMAND_LINE_ARGS.harvestReport,
        COMMAND_LINE_ARGS.debugAPI
      ];
      if (booleanTypeArgs.includes(key as any) && value !== undefined) {
        value = '1';
      }

      if (value === null) {
        throw Error(`Command-line option requires a value for '--${key}'`);
      }
      if (value && typeof value === 'string') {
        return {
          src: 'cli',
          key: __getOptNameUsed(key),
          value: value.trim()
        };
      }
      return undefined;
    };

    // Handle --log-level: none
    let consoleLoggerLevel = __getValue(COMMAND_LINE_ARGS.logLevel);
    let consoleLoggerEnabled: CLIOptionParserEntry | undefined;
    if (consoleLoggerLevel?.value === 'none') {
      consoleLoggerEnabled = {
        src: 'cli',
        key: '',
        value: '0'
      };
      consoleLoggerLevel = undefined;
    }

    return {
      configFile: __getValue(COMMAND_LINE_ARGS.configFile),
      targetURLs: __getValue(COMMAND_LINE_ARGS.targetURL),
      debugAPI: __getValue(COMMAND_LINE_ARGS.debugAPI),
      cookie: __getValue(COMMAND_LINE_ARGS.cookie),
      useStatusCache: __getForceUseStatusCacheValue(__getValue(COMMAND_LINE_ARGS.force)),
      pathToFFmpeg: __getValue(COMMAND_LINE_ARGS.ffmpeg),
      pathToDeno: __getValue(COMMAND_LINE_ARGS.deno),
      outDir: __getValue(COMMAND_LINE_ARGS.outDir),
      dirNameFormat: {
        campaign: undefined,
        content: undefined
      },
      filenameFormat: {
        media: undefined
      },
      include: {
        lockedContent: undefined,
        postsWithMediaType: undefined,
        campaignInfo: undefined,
        contentInfo: undefined,
        previewMedia: undefined,
        contentMedia: undefined,
        allMediaVariants: undefined,
        mediaThumbnails: undefined
      },
      request: {
        maxRetries: undefined,
        maxConcurrent: undefined,
        minTime: undefined,
        pageDelay: undefined,
        postDelay: undefined,
        targetDelay: undefined,
        userAgent: undefined
      },
      fileExistsAction: {
        content: undefined,
        info: undefined,
        infoAPI: undefined
      },
      noPrompt: __getValue(COMMAND_LINE_ARGS.noPrompt),
      dryRun: __getValue(COMMAND_LINE_ARGS.dryRun),
      consoleLogger: {
        enabled: consoleLoggerEnabled,
        logLevel: consoleLoggerLevel,
        include: {
          dateTime: undefined,
          level: undefined,
          originator: undefined,
          errorStack: undefined
        },
        dateTimeFormat: undefined,
        color: undefined
      }
    };

    function __getForceUseStatusCacheValue(force?: CLIOptionParserEntry) {
      if (!force) {
        return undefined;
      }
      return {
        ...force,
        key: '--force',
        value: '0'
      };
    }
  }

  static showUsage() {
    let opts;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    if (opts.help) {
      const content = [
        'Command-line options override corresponding options in configuration file loaded through \'-C\'.',
        EOL,
        'Project home: {underline https://github.com/patrickkfkan/patreon-dl}'
      ];
      const sections: commandLineUsage.Section[] = [
        {
          header: 'Usage',
          content: 'patreon-dl [OPTION]... URL'
        },
        {
          header: 'Options',
          optionList: OPT_DEFS,
          hide: ['target-url', COMMAND_LINE_ARGS.debugAPI]
        },
        {
          content: content.join(EOL)
        }
      ];
      const banner = getPackageInfo().banner;
      if (banner) {
        sections.unshift({ header: banner, raw: true });
      }
      const usage = commandLineUsage(sections);
      console.log(usage);

      return true;
    }

    return false;
  }

  static configureYouTube() {
    let opts;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    return opts['configure-youtube'];
  }

  static #listX(x: 'tiers' | 'posts') {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return null;
    }

    const __getTargets = (opt: `--list-${typeof x}` | `--list-${typeof x}-uid`) => {
      let listX;
      switch (opt) {
        case '--list-tiers':
          listX = opts[COMMAND_LINE_ARGS.listTiers];
          break;
        case '--list-tiers-uid':
          listX = opts[COMMAND_LINE_ARGS.listTiersByUserId];
          break;
        case '--list-posts':
          listX = opts[COMMAND_LINE_ARGS.listPosts];
          break;
        case '--list-posts-uid':
          listX = opts[COMMAND_LINE_ARGS.listPostsByUserId];
          break;
      }
      if (listX === null) { // Option provided but has empty value
        return null;
      }
      else if (typeof listX === 'string') {
        const targets = listX.split(',').map((v) => v.trim()).filter((v) => v);
        if (targets.length === 0) {
          throw Error(`'${opt}' has invalid value`);
        }
        return targets;
      }
      return false;
    };

    const vanities = __getTargets(`--list-${x}`);
    const userIds = __getTargets(`--list-${x}-uid`);
    if (vanities === null || userIds === null) {
      const opt = vanities === null ? `--list-${x}` : `--list-${x}-uid`;
      throw Error(`'${opt}' missing value`);
    }

    if (vanities === false && userIds === false) {
      return null;
    }

    return {
      byVanity: vanities || [],
      byUserId: userIds || []
    };
  }

  static listTiers() {
    return this.#listX('tiers');
  }

  static listPosts() {
    return this.#listX('posts');
  }

  static inventory() {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    return !!opts[COMMAND_LINE_ARGS.inventory];
  }

  static inventoryDelta() {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    return !!opts[COMMAND_LINE_ARGS.inventoryDelta];
  }

  static inventoryMerge() {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    return !!opts[COMMAND_LINE_ARGS.inventoryMerge];
  }

  static inventoryOut() {
    return this.#getStringOption(COMMAND_LINE_ARGS.inventoryOut);
  }

  static inventoryLimit() {
    return this.#getNumberOption(COMMAND_LINE_ARGS.inventoryLimit);
  }

  static inventoryResume() {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    return !!opts[COMMAND_LINE_ARGS.inventoryResume];
  }

  static inventoryReport() {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    return !!opts[COMMAND_LINE_ARGS.inventoryReport];
  }

  static inventorySelect() {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    return !!opts[COMMAND_LINE_ARGS.inventorySelect];
  }

  static harvestReport() {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return false;
    }
    return !!opts[COMMAND_LINE_ARGS.harvestReport];
  }

  static inventoryIn() {
    return this.#getStringOption(COMMAND_LINE_ARGS.inventoryIn);
  }

  static deltaIn() {
    return this.#getStringOption(COMMAND_LINE_ARGS.deltaIn);
  }

  static dbIn() {
    return this.#getStringOption(COMMAND_LINE_ARGS.dbIn);
  }

  static targetIn() {
    return this.#getStringOption(COMMAND_LINE_ARGS.targetIn);
  }

  static targetOut() {
    return this.#getStringOption(COMMAND_LINE_ARGS.targetOut);
  }

  static selectMedia() {
    return this.#getStringOption(COMMAND_LINE_ARGS.selectMedia);
  }

  static selectTag() {
    return this.#getStringOption(COMMAND_LINE_ARGS.selectTag);
  }

  static selectLimit() {
    return this.#getNumberOption(COMMAND_LINE_ARGS.selectLimit);
  }

  static #getNumberOption(key: typeof COMMAND_LINE_ARGS[keyof typeof COMMAND_LINE_ARGS]) {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return undefined;
    }
    const value = opts[key];
    if (value === null) {
      throw Error(`'--${key}' missing value`);
    }
    if (typeof value === 'number') {
      return value;
    }
    return undefined;
  }

  static #getStringOption(key: typeof COMMAND_LINE_ARGS[keyof typeof COMMAND_LINE_ARGS]) {
    let opts: commandLineArgs.CommandLineOptions;
    try {
      opts = this.#parseArgs();
    }
    catch (_error: unknown) {
      return undefined;
    }
    const value = opts[key];
    if (value === null) {
      throw Error(`'--${key}' missing value`);
    }
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return undefined;
  }

  static #parseArgs() {
    const opts = commandLineArgs(OPT_DEFS, { stopAtFirstUnknown: true });
    if (opts['_unknown']) {
      const unknownOpt = Object.keys(opts['_unknown'])[0];
      throw Error(`Unknown command-line option '${unknownOpt}'`);
    }
    return opts;
  }
}
