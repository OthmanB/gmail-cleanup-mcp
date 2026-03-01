import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAndValidatePathInRoots } from '../src/path_security.js';

test('resolveAndValidatePathInRoots allows file under allowed root', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gmail-cleanup-'));
  const root = path.join(tmp, 'lists');
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'senders.txt');
  await fs.writeFile(file, 'newsletter@example.com\n', 'utf8');

  const resolved = await resolveAndValidatePathInRoots({
    inputPath: file,
    allowedRoots: [root],
  });

  assert.equal(resolved, await fs.realpath(file));
});

test('resolveAndValidatePathInRoots rejects file outside allowed root', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gmail-cleanup-'));
  const root = path.join(tmp, 'lists');
  const outside = path.join(tmp, 'outside.txt');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(outside, 'x@example.com\n', 'utf8');

  await assert.rejects(
    resolveAndValidatePathInRoots({
      inputPath: outside,
      allowedRoots: [root],
    }),
    /Path is not allowed/
  );
});
