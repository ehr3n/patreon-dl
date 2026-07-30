import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('matches canonical Patreon target URLs to slugged inventory URLs by post ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-dl-harvest-report-'));
  try {
    const archiveRoot = path.join(root, 'archive');
    const stateRoot = path.join(archiveRoot, '.patreon-dl');
    const inventoryFile = path.join(stateRoot, 'inventory-current.jsonl');
    const targetsFile = path.join(stateRoot, 'targets.txt');
    const databaseFile = path.join(stateRoot, 'db.sqlite');
    const reportFile = path.join(stateRoot, 'harvest-report.json');
    const slugURL = 'https://www.patreon.com/Creator/posts/example-title-164186046';
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(inventoryFile, `${JSON.stringify({
      type: 'post',
      schemaVersion: 1,
      id: '164186046',
      url: slugURL,
      title: 'Example post',
      media: []
    })}\n`);
    fs.writeFileSync(targetsFile, 'https://www.patreon.com/posts/164186046\n');

    execFileSync(process.execPath, [
      path.join(repoRoot, 'bin', 'patreon-dl.js'),
      '--out-dir', archiveRoot,
      '--harvest-report',
      '--inventory-in', inventoryFile,
      '--target-in', targetsFile,
      '--db-in', databaseFile,
      '--harvest-report-out', reportFile
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: [ 'ignore', 'pipe', 'pipe' ]
    });

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    assert.equal(report.targets.uniqueTargetURLs, 1);
    assert.equal(report.targets.matchedInventoryPosts, 1);
    assert.equal(report.targets.missingFromInventory, 0);
    assert.equal(report.targets.pendingPosts, 1);
    assert.equal(report.database.exists, false);
    assert.deepEqual(report.lists.targetURLsMissingFromInventory, []);
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('counts downloaded audio attachments with the same taxonomy as inventory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-dl-harvest-report-audio-attachments-'));
  try {
    const archiveRoot = path.join(root, 'archive');
    const stateRoot = path.join(archiveRoot, '.patreon-dl');
    const inventoryFile = path.join(stateRoot, 'inventory-current.jsonl');
    const targetsFile = path.join(stateRoot, 'targets.txt');
    const databaseFile = path.join(stateRoot, 'db.sqlite');
    const reportFile = path.join(stateRoot, 'harvest-report.json');
    const postID = '121584826';
    const postURL = `https://www.patreon.com/Creator/posts/three-audio-files-${postID}`;
    const media = [
      { id: 'audio-main', source: 'audio', type: 'audio', filename: 'main.mp3', mimeType: 'audio/mpeg', hasDownloadURL: true },
      { id: 'audio-4m', source: 'attachments', type: 'audio', filename: '4m.mp3', mimeType: 'audio/mpeg', hasDownloadURL: true },
      { id: 'audio-4a', source: 'attachments', type: 'audio', filename: '4a.mp3', mimeType: 'audio/mpeg', hasDownloadURL: true }
    ];
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(inventoryFile, `${JSON.stringify({
      type: 'post', schemaVersion: 1, id: postID, url: postURL, title: 'Three audio files', media
    })}\n`);
    fs.writeFileSync(targetsFile, `https://www.patreon.com/posts/${postID}\n`);

    const database = new Database(databaseFile);
    database.exec(`
      CREATE TABLE content (content_id TEXT PRIMARY KEY, content_type TEXT NOT NULL, details TEXT);
      CREATE TABLE media (media_id TEXT PRIMARY KEY, media_type TEXT NOT NULL, download_path TEXT NOT NULL);
      CREATE TABLE content_media (
        media_id TEXT NOT NULL, content_id TEXT NOT NULL, content_type TEXT NOT NULL, is_preview INTEGER
      );
    `);
    database.prepare('INSERT INTO content (content_id, content_type, details) VALUES (?, ?, ?)')
      .run(postID, 'post', JSON.stringify({ url: postURL }));
    for (const item of media) {
      const relativePath = path.join('media', item.filename);
      fs.mkdirSync(path.dirname(path.join(archiveRoot, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(archiveRoot, relativePath), item.id);
      database.prepare('INSERT INTO media (media_id, media_type, download_path) VALUES (?, ?, ?)')
        .run(item.id, 'audio', relativePath);
      database.prepare('INSERT INTO content_media (media_id, content_id, content_type, is_preview) VALUES (?, ?, ?, ?)')
        .run(item.id, postID, 'post', 0);
    }
    database.close();

    execFileSync(process.execPath, [
      path.join(repoRoot, 'bin', 'patreon-dl.js'),
      '--out-dir', archiveRoot,
      '--harvest-report',
      '--inventory-in', inventoryFile,
      '--target-in', targetsFile,
      '--db-in', databaseFile,
      '--harvest-report-out', reportFile
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: [ 'ignore', 'pipe', 'pipe' ]
    });

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    assert.deepEqual(report.expectedTargetAssets, { attachment: 2, audio: 3 });
    assert.deepEqual(report.downloadedTargetMedia, { attachment: 2, audio: 3 });
    assert.equal(report.database.selectedMediaRows, 3);
    assert.equal(report.database.selectedMediaFilesPresent, 3);
    assert.equal(report.database.selectedMediaFilesMissing, 0);
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('selects audio-only attachments and enables attachment downloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-dl-inventory-select-audio-attachment-'));
  try {
    const archiveRoot = path.join(root, 'archive');
    const stateRoot = path.join(archiveRoot, '.patreon-dl');
    const inventoryFile = path.join(stateRoot, 'inventory-current.jsonl');
    const targetsFile = path.join(stateRoot, 'targets.txt');
    const postURL = 'https://www.patreon.com/Creator/posts/audio-attachment-only-121584826';
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(inventoryFile, `${JSON.stringify({
      type: 'post',
      schemaVersion: 1,
      id: '121584826',
      url: postURL,
      title: 'Audio attachment only',
      media: [ {
        id: 'audio-attachment',
        source: 'attachments',
        type: 'audio',
        filename: 'attachment.mp3',
        mimeType: 'audio/mpeg',
        hasDownloadURL: true
      } ]
    })}\n`);

    execFileSync(process.execPath, [
      path.join(repoRoot, 'bin', 'patreon-dl.js'),
      '--out-dir', archiveRoot,
      '--inventory-select',
      '--inventory-in', inventoryFile,
      '--target-out', targetsFile,
      '--select-media', 'audio'
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: [ 'ignore', 'pipe', 'pipe' ]
    });

    const targets = fs.readFileSync(targetsFile, 'utf-8');
    assert.match(targets, new RegExp(postURL, 'u'));
    assert.match(targets, /include\.posts\.with\.media\.type = audio,attachment/u);
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
