import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSenderList } from '../src/sender_list.js';

test('parseSenderList normalizes line types and appends suffix', () => {
  const listText = [
    '# comment',
    'newsletter@example.com',
    '@example.org',
    'from:"Some Sender" older_than:1y',
    'Sender Name',
    '',
  ].join('\n');

  const out = parseSenderList({
    listText,
    defaultQuerySuffix: '-in:trash -in:spam',
  });

  assert.equal(out.length, 4);
  assert.equal(out[0]?.kind, 'email');
  assert.equal(out[0]?.normalized_query, 'from:newsletter@example.com -in:trash -in:spam');

  assert.equal(out[1]?.kind, 'domain');
  assert.equal(out[1]?.normalized_query, 'from:example.org -in:trash -in:spam');

  assert.equal(out[2]?.kind, 'raw_query');
  assert.equal(out[2]?.normalized_query, 'from:"Some Sender" older_than:1y -in:trash -in:spam');

  assert.equal(out[3]?.kind, 'name');
  assert.equal(out[3]?.normalized_query, 'from:"Sender Name" -in:trash -in:spam');
});
