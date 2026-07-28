import assert from 'node:assert/strict';
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
