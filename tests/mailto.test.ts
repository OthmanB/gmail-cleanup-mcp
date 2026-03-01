import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMailtoLink } from '../src/tools/mailto.js';

test('parseMailtoLink parses recipients and query params', () => {
  const parsed = parseMailtoLink(
    'mailto:list@example.com?subject=unsubscribe&body=Please%20remove%20me&cc=cc1@example.com,cc2@example.com'
  );

  assert.ok(parsed);
  assert.deepEqual(parsed.to, ['list@example.com']);
  assert.deepEqual(parsed.cc, ['cc1@example.com', 'cc2@example.com']);
  assert.deepEqual(parsed.bcc, []);
  assert.equal(parsed.subject, 'unsubscribe');
  assert.equal(parsed.body, 'Please remove me');
});

test('parseMailtoLink rejects invalid links', () => {
  assert.equal(parseMailtoLink('https://example.com'), null);
  assert.equal(parseMailtoLink('mailto:not-an-email'), null);
});
