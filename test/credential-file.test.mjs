import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readCookieFile } from '../dist/cli/CLIOptions.js';

test('reads a private cookie file relative to the creator config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-dl-cookie-file-'));
  try {
    const configDir = path.join(root, 'creators');
    const credentialDir = path.join(root, 'credentials');
    fs.mkdirSync(configDir);
    fs.mkdirSync(credentialDir);
    const configFile = path.join(configDir, 'creator.conf');
    const credentialFile = path.join(credentialDir, 'primary.cookie');
    fs.writeFileSync(configFile, '[downloader]\n', { mode: 0o600 });
    fs.writeFileSync(credentialFile, 'session_id=test-only\n', { mode: 0o600 });

    assert.equal(readCookieFile('../credentials/primary.cookie', configFile), 'session_id=test-only');
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a cookie file accessible by group or other users', {
  skip: process.platform === 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-dl-cookie-mode-'));
  try {
    const credentialFile = path.join(root, 'primary.cookie');
    fs.writeFileSync(credentialFile, 'session_id=test-only\n', { mode: 0o644 });

    assert.throws(() => readCookieFile(credentialFile), /mode 600/u);
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects empty, multiline, and symbolic-link cookie files', {
  skip: process.platform === 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-dl-cookie-shape-'));
  try {
    const emptyFile = path.join(root, 'empty.cookie');
    const multilineFile = path.join(root, 'multiline.cookie');
    const linkedFile = path.join(root, 'linked.cookie');
    fs.writeFileSync(emptyFile, '', { mode: 0o600 });
    fs.writeFileSync(multilineFile, 'first\nsecond\n', { mode: 0o600 });
    fs.symlinkSync(multilineFile, linkedFile);

    assert.throws(() => readCookieFile(emptyFile), /empty/u);
    assert.throws(() => readCookieFile(multilineFile), /exactly one line/u);
    assert.throws(() => readCookieFile(linkedFile), /regular file/u);
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
