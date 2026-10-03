import type { TeamFile } from '../file/types.ts';

// A task name is one path segment. It is also the last segment of the folder and part of the branch.
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function taskProblem(task: string): string | null {
  if (!TASK_NAME.test(task)) {
    return 'a task name is one segment of letters, digits, ".", "_" and "-", and it starts with a letter or a digit';
  }
  return null;
}

// Fills `{kind}` and `{task}`. Null when a placeholder has no value, or one is left that this command doesn't know.
export function fillPattern(pattern: string, values: Record<string, string | undefined>): string | null {
  let unknown = false;
  const filled = pattern.replace(/\{([^}]*)\}/g, (token, name: string) => {
    const value = values[name];
    if (value === undefined) {
      unknown = true;
      return token;
    }
    return value;
  });
  return unknown ? null : filled;
}

// The first name a public project's forbidden_public pattern matches, as "name matches pattern".
export function publicNameHit(team: Pick<TeamFile, 'visibility' | 'identity'>, names: string[]): string | null {
  if (team.visibility !== 'public') return null;
  for (const source of team.identity.forbiddenPublic) {
    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch (error) {
      return `forbidden_public pattern ${JSON.stringify(source)} is not a regular expression: ${(error as Error).message}`;
    }
    for (const name of names) {
      if (regex.test(name)) return `${JSON.stringify(name)} matches forbidden_public ${JSON.stringify(source)}`;
    }
  }
  return null;
}
