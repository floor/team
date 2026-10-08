// The Linear adapter over the answer map, the release world's shape: no test here opens a
// network connection, and the credential is a deliberate non-real string. The document, the one
// header, the mapping and the page bound are the whole read; a second page is a notice, never a
// silent truncation.
import { describe, expect, test } from 'bun:test';
import { LINEAR_URL } from '../src/release/checks.ts';
import type { Attempt, Fetch, RequestOptions } from '../src/release/http.ts';
import { BROKER_TASKS_QUERY, ISSUES_FIRST, MORE_TASKS, linearRead } from '../src/tasks/linear.ts';

const PROJECT = '01234567-89ab-cdef-0123-456789abcdef';
const KEY = 'test-key-not-real';

type Recorded = { url: string; request?: RequestOptions };

/** The one answer the adapter's fetch serves, and every request it received. */
function world(answer: Attempt | ((request: RequestOptions | undefined) => Attempt)): { fetch: Fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetcher: Fetch = (url, request) => {
    requests.push(request === undefined ? { url } : { url, request });
    return Promise.resolve(typeof answer === 'function' ? answer(request) : answer);
  };
  return { fetch: fetcher, requests };
}

function answer(value: unknown, status = 200): Attempt {
  return { kind: 'http', status, body: JSON.stringify(value) };
}

/** A well-formed issues answer: every field overridable per case, including to a malformed one. */
function issues(nodes: unknown[], hasNextPage: unknown = false): Record<string, unknown> {
  return { data: { project: { id: PROJECT, issues: { nodes, pageInfo: { hasNextPage } } } } };
}

/** One well-formed node, as the GraphQL selection names it. */
function node(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifier: 'ACME-1',
    title: 'a task',
    priority: 1,
    assignee: { displayName: 'worker' },
    projectMilestone: { name: 'M1' },
    targetDate: '2026-10-31',
    description: 'the body',
    ...change,
  };
}

async function read(worldAnswer: Attempt | ((request: RequestOptions | undefined) => Attempt), credential = KEY) {
  const served = world(worldAnswer);
  const result = await linearRead({ project: PROJECT, fetch: served.fetch, credential });
  return { result, requests: served.requests };
}

describe('the Linear read', () => {
  test('one POST to the Linear host, the key in exactly one header, one bounded document', async () => {
    const { result, requests } = await read(answer(issues([node()])));
    expect(result.kind).toBe('served');
    expect(requests.length).toBe(1);
    const one = requests[0]!;
    expect(one.url).toBe(LINEAR_URL);
    expect(one.request?.method).toBe('POST');
    // Exactly the two headers the caller names — the key once, and nothing of the wiring's own.
    expect(one.request?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: KEY });
    const body = JSON.parse(one.request?.body ?? '') as { query: string; variables: Record<string, unknown> };
    expect(body.query).toBe(BROKER_TASKS_QUERY);
    expect(body.variables).toEqual({ projectId: PROJECT, first: 100 });
    expect(ISSUES_FIRST).toBe(100);
    // The one operation is a query: the document has no mutation and no second page.
    expect(BROKER_TASKS_QUERY.startsWith('query BrokerTasks(')).toBe(true);
    expect(BROKER_TASKS_QUERY).not.toContain('mutation');
    expect(BROKER_TASKS_QUERY).not.toContain('$after');
    // The key is nowhere in what the read returns.
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test('a credential that is not a key is refused before any request is formed', async () => {
    const { result, requests } = await read(answer(issues([])), 'not a key\n');
    expect(result).toEqual({ kind: 'refused', message: 'the credential is not a key' });
    expect(requests.length).toBe(0);
  });

  test('the page bound is a byte: true is a notice, and the take proceeds', async () => {
    expect(MORE_TASKS).toBe('the tracker holds more tasks than this read; the take still proceeds');
    const { result } = await read(answer(issues([node()], true)));
    expect(result).toMatchObject({ kind: 'served', notice: MORE_TASKS });
    const bounded = await read(answer(issues([node()], false)));
    expect(bounded.result).toEqual({
      kind: 'served',
      read: {
        kind: 'records',
        records: [
          { id: 'ACME-1', title: 'a task', priority: 1, assignee: 'worker', milestone: 'M1', deadline: '2026-10-31', description: 'the body' },
        ],
        refusals: [],
      },
    });
  });

  test('a bound that is not a boolean refuses: the read cannot say it was the whole tracker', async () => {
    for (const bound of [undefined, null, 'yes', 1]) {
      const { result } = await read(answer({ data: { project: { id: PROJECT, issues: { nodes: [], pageInfo: { hasNextPage: bound } } } } }));
      expect(result).toEqual({ kind: 'refused', message: 'the tracker answer did not carry a page bound' });
    }
    const missing = await read(answer({ data: { project: { id: PROJECT, issues: { nodes: [] } } } }));
    expect(missing.result).toEqual({ kind: 'refused', message: 'the tracker answer did not carry a page bound' });
  });

  test('the record mapping carries the file adapter\'s validation, refused by index and id', async () => {
    const { result } = await read(
      answer(
        issues([
          node({ identifier: 'ACME-1' }),
          node({ identifier: 'ACME-2', title: '' }),
          node({ identifier: 'not a task id\n' }),
          node({ identifier: 'ACME-3', assignee: { displayName: '' } }),
          node({ identifier: 'ACME-4', priority: 0 }),
          node({ identifier: 'ACME-4' }),
          node({ identifier: 'ACME-5', description: null, targetDate: null, projectMilestone: null, assignee: null }),
        ]),
      ),
    );
    if (result.kind !== 'served' || result.read.kind !== 'records') throw new Error('the read was not served');
    expect(result.read.records.map((record) => [record.id, record.priority, record.description])).toEqual([
      ['ACME-1', 1, 'the body'],
      ['ACME-4', undefined, 'the body'],
      ['ACME-5', 1, undefined],
    ]);
    expect(result.read.refusals).toEqual([
      { index: 2, id: 'ACME-2', reason: 'title must be a single line' },
      { index: 3, reason: 'its id is not a task id' },
      { index: 4, id: 'ACME-3', reason: 'assignee must be text' },
      { index: 6, id: 'ACME-4', reason: 'its id repeats an earlier record' },
    ]);
    expect(JSON.stringify(result.read.records)).not.toContain(KEY);
  });

  test('every failed read is a refusal, never a half-read', async () => {
    const cases: [string, Attempt | ((request: RequestOptions | undefined) => Attempt), string][] = [
      ['a transport failure', { kind: 'transport' }, 'the tracker could not be read'],
      ['a timeout', { kind: 'timeout' }, 'the tracker could not be read'],
      ['a 500', answer({ errors: [{ message: 'boom' }] }, 500), 'the tracker could not be read'],
      ['a 200 with a GraphQL errors key', answer({ errors: [{ message: 'boom' }], data: null }), 'the tracker could not be read'],
      ['malformed JSON', { kind: 'http', status: 200, body: 'not json' }, 'the tracker could not be read'],
      ['a missing project', answer({ data: { project: null } }), 'the tracker does not hold that project'],
      ['another project', answer({ data: { project: { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', issues: { nodes: [], pageInfo: { hasNextPage: false } } } } }), 'the tracker does not hold that project'],
      ['an undecodable body', { kind: 'undecodable', status: 200 }, 'the tracker could not be read'],
      ['an over-limit body', { kind: 'too-large', status: 200, prefix: '"' }, 'the tracker could not be read'],
      ['nodes that are not a list', answer({ data: { project: { id: PROJECT, issues: { nodes: 'ACME-1', pageInfo: { hasNextPage: false } } } } }), 'the tracker could not be read'],
    ];
    for (const [, served, message] of cases) {
      const { result } = await read(served);
      expect(result).toEqual({ kind: 'refused', message });
    }
  });
});
