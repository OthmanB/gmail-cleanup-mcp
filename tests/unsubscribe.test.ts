import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUnsubscribeInfo } from '../src/unsubscribe.js';

test('extractUnsubscribeInfo parses angle-bracket list and one-click flag', () => {
  const out = extractUnsubscribeInfo({
    headers: {
      'List-Unsubscribe': '<mailto:leave@example.com>, <https://example.com/unsub?id=123>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });

  assert.deepEqual(out.listUnsubscribe, [
    'mailto:leave@example.com',
    'https://example.com/unsub?id=123',
  ]);
  assert.equal(out.oneClick, true);
});
