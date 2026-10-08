// The first credentialed task adapter: one bounded, read-only GraphQL read of the issues under
// the configured project. It runs only inside the broker process, and the discipline is the
// release check's byte for byte (src/release/checks.ts): one POST to the constant LINEAR_URL,
// the key in exactly one header, no headers of the wiring's own, no redirect followed, a
// timeout and a size-capped body (src/release/http.ts). The key is validated before anything is
// built from it. No write, no second page: a `hasNextPage` answer is a notice, never a silent
// truncation. It returns the same TaskRead union the file adapter returns, so the command's
// take path treats both sources identically.
import { LINEAR_URL } from '../release/checks.ts';
import type { Fetch } from '../release/http.ts';
import type { TaskRead, TaskRecord, TaskRefusal } from './adapter.ts';

/** The release precedent's page size, shaped at 100. A second page is deferred; the notice
 *  below is what tells a seat the read was not the whole tracker. */
export const ISSUES_FIRST = 100;

/** The pinned byte a `hasNextPage: true` answer carries. The take still proceeds. */
export const MORE_TASKS = 'the tracker holds more tasks than this read; the take still proceeds';

/** The normative GraphQL document: the complete bounded read of one project's first page of
 *  issues. No operation, variable or selected datum beyond it. */
export const BROKER_TASKS_QUERY = `query BrokerTasks($projectId: String!, $first: Int!) {
  project(id: $projectId) {
    id
    issues(first: $first) {
      nodes {
        identifier
        title
        priority
        assignee { displayName }
        projectMilestone { name }
        targetDate
        description
      }
      pageInfo { hasNextPage }
    }
  }
}`;

export type LinearReadInput = {
  project: string;
  fetch: Fetch;
  /** The key. It reaches exactly one header and is never echoed into a message. */
  credential: string;
};

export type LinearReadResult =
  | { kind: 'served'; read: TaskRead; notice?: string }
  | { kind: 'refused'; message: string };

const UNREAD = 'the tracker could not be read';
const NO_PROJECT = 'the tracker does not hold that project';
const UNBOUNDED = 'the tracker answer did not carry a page bound';

export async function linearRead(input: LinearReadInput): Promise<LinearReadResult> {
  if (!legalKey(input.credential)) return { kind: 'refused', message: 'the credential is not a key' };
  // One bounded read: the document and variables above, the key in exactly one header, on the
  // Linear host and nowhere else. The wiring follows no redirect, so the key can never travel
  // to another host.
  const body = JSON.stringify({ query: BROKER_TASKS_QUERY, variables: { projectId: input.project, first: ISSUES_FIRST } });
  const reply = await input.fetch(LINEAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: input.credential },
    body,
  });
  if (reply.kind !== 'http') return { kind: 'refused', message: UNREAD };
  if (reply.status < 200 || reply.status > 299) return { kind: 'refused', message: UNREAD };
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(reply.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'refused', message: UNREAD };
    value = parsed as Record<string, unknown>;
  } catch {
    return { kind: 'refused', message: UNREAD };
  }
  // The response is a JSON object with a data object and no errors key at all; anything else —
  // a GraphQL errors answer (an unknown project id included), a missing data, malformed JSON —
  // is a failed read.
  if ('errors' in value) return { kind: 'refused', message: UNREAD };
  const data = value.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'refused', message: UNREAD };
  const project = (data as Record<string, unknown>).project;
  if (!project || typeof project !== 'object' || Array.isArray(project)) return { kind: 'refused', message: NO_PROJECT };
  const held = project as Record<string, unknown>;
  if (typeof held.id !== 'string' || held.id !== input.project) return { kind: 'refused', message: NO_PROJECT };
  const issues = held.issues;
  if (!issues || typeof issues !== 'object' || Array.isArray(issues)) return { kind: 'refused', message: UNREAD };
  const page = issues as Record<string, unknown>;
  if (!Array.isArray(page.nodes)) return { kind: 'refused', message: UNREAD };
  const pageInfo = page.pageInfo;
  if (!pageInfo || typeof pageInfo !== 'object' || Array.isArray(pageInfo)) return { kind: 'refused', message: UNBOUNDED };
  const next = (pageInfo as Record<string, unknown>).hasNextPage;
  // A malformed bound means this read cannot say whether it was the whole tracker, and a silent
  // truncation is the one thing the read must never be.
  if (typeof next !== 'boolean') return { kind: 'refused', message: UNBOUNDED };
  const records: TaskRecord[] = [];
  const refusals: TaskRefusal[] = [];
  const accepted = new Set<string>();
  page.nodes.forEach((node, index) => {
    const read = readNode(node, index + 1);
    if ('reason' in read) {
      refusals.push(read);
      return;
    }
    if (accepted.has(read.id)) {
      refusals.push({ index: index + 1, id: read.id, reason: 'its id repeats an earlier record' });
      return;
    }
    accepted.add(read.id);
    records.push(read);
  });
  const read: TaskRead = { kind: 'records', records, refusals };
  if (next) return { kind: 'served', read, notice: MORE_TASKS };
  return { kind: 'served', read };
}

/** The key may exist only to become the one header: non-empty, ASCII 0x21 through 0x7e — the
 *  rule `src/release/checks.ts` holds its own reader to. */
function legalKey(key: string): boolean {
  if (key.length === 0) return false;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** One issue node mapped to the typed record with the file adapter's validation style; a node
 *  the record cannot carry is refused, named by its index, never dropped. The identifier is
 *  judged by presence alone here: a source may name a task by its URL, and whether the id is a
 *  task id is the broker's call, on the final id the policy leaves (fix2 P2, src/broker/server.ts). */
function readNode(node: unknown, index: number): TaskRecord | TaskRefusal {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { index, reason: 'the tracker node is not a task' };
  const entries = node as Record<string, unknown>;
  const identifier = entries.identifier;
  if (typeof identifier !== 'string' || identifier === '') return { index, reason: 'id is required' };
  const title = line(entries.title);
  if (entries.title === undefined || entries.title === null) return { index, id: identifier, reason: 'title is required' };
  if (title === undefined || title.length > 200) return { index, id: identifier, reason: 'title must be a single line' };
  const priority = entries.priority;
  if (priority !== undefined && priority !== null) {
    const legal = (typeof priority === 'number' && Number.isFinite(priority)) || (typeof priority === 'string' && priority !== '');
    if (!legal) return { index, id: identifier, reason: 'priority is not text or a number' };
  }
  const assignee = named(entries.assignee, 'displayName');
  if (assignee === 'bad') return { index, id: identifier, reason: 'assignee must be text' };
  const milestone = named(entries.projectMilestone, 'name');
  if (milestone === 'bad') return { index, id: identifier, reason: 'milestone must be text' };
  const deadline = nullableText(entries.targetDate);
  if (deadline === 'bad') return { index, id: identifier, reason: 'deadline must be text' };
  const description = nullableText(entries.description);
  if (description === 'bad') return { index, id: identifier, reason: 'description must be text' };
  if (description !== undefined && description.length > 4000) return { index, id: identifier, reason: 'description is over 4000 characters' };
  const record: TaskRecord = { id: identifier, title };
  if (typeof priority === 'number' || typeof priority === 'string') {
    if (typeof priority !== 'number' || priority > 0) record.priority = priority;
  }
  if (assignee !== undefined) record.assignee = assignee;
  if (milestone !== undefined) record.milestone = milestone;
  if (deadline !== undefined) record.deadline = deadline;
  if (description !== undefined) record.description = description;
  return record;
}

function line(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.includes('\n') || value.includes('\r')) return undefined;
  return value;
}

/** A linked node's single text field (`assignee.displayName`, `projectMilestone.name`): null is
 *  absent, an empty or malformed one is a refusal, like the file adapter's text fields. */
function named(value: unknown, key: string): string | undefined | 'bad' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'bad';
  const field = (value as Record<string, unknown>)[key];
  if (field === undefined || field === null) return undefined;
  const text = line(field);
  if (text === undefined) return 'bad';
  return text;
}

function nullableText(value: unknown): string | undefined | 'bad' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return 'bad';
  return value === '' ? undefined : value;
}
