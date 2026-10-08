// The one block printer. `team issues` and `team next` both call it, so the two pages cannot drift.
import type { TaskRecord } from './adapter.ts';

/** One trailing newline is the block-scalar ending, not a blank line to print. */
export function descriptionLines(value: string): string[] {
  const shown = value.endsWith('\n') ? value.slice(0, -1) : value;
  const parts = shown.split('\n');
  const lines = [`  description: ${parts[0] ?? ''}`];
  for (const part of parts.slice(1)) lines.push(part === '' ? '' : `    ${part}`);
  return lines;
}

/** The issues block, byte for byte: one record per block, a blank line between, one trailing newline. */
export function formatRecords(records: readonly TaskRecord[]): string {
  const blocks = records.map((record) => {
    const lines = [`${record.id}  ${record.title}`];
    if (record.priority !== undefined) lines.push(`  priority: ${record.priority}`);
    if (record.assignee !== undefined) lines.push(`  assignee: ${record.assignee}`);
    if (record.milestone !== undefined) lines.push(`  milestone: ${record.milestone}`);
    if (record.deadline !== undefined) lines.push(`  deadline: ${record.deadline}`);
    if (record.blockedBy && record.blockedBy.length) lines.push(`  blocked-by: ${record.blockedBy.join(', ')}`);
    if (record.repos && record.repos.length) lines.push(`  repos: ${record.repos.join(', ')}`);
    if (record.needs && record.needs.length) lines.push(`  needs: ${record.needs.join(', ')}`);
    if (record.description !== undefined) lines.push(...descriptionLines(record.description));
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}
