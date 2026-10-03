export const DEFAULT_COMMIT_TEMPLATE = 'Agent: {display} · {role}';
export const DEFAULT_PR_TEMPLATE = '**Agent:** {display} · {role}';

// Added to every file's `identity.forbidden`, never replaced by it.
export const DEFAULT_FORBIDDEN: string[] = ['^Claude-Session:', 'https?://claude\\.ai/code/session'];

export type Signer = { display: string; model: string; version: string; role: string };

export function renderSignature(template: string, seat: Signer): string {
  return template.replace(/\{(display|model|version|role)\}/g, (_, name: keyof Signer) => seat[name]);
}

// What a template must hold to name a model, its version and a role.
export function templateProblem(template: string): string | null {
  if (!template.includes('{role}')) return 'the template must contain {role}';
  if (!template.includes('{display}') && !(template.includes('{model}') && template.includes('{version}'))) {
    return 'the template must contain {display}, or both {model} and {version}';
  }
  const unknown = template.match(/\{[^}]*\}/g)?.find((p) => !/^\{(display|model|version|role)\}$/.test(p));
  return unknown ? `unknown placeholder ${unknown}` : null;
}

// git reads a line as a trailer only when it is "<token>: <value>", the token without spaces.
export function isTrailerTemplate(template: string): boolean {
  const line = renderSignature(template, { display: 'Model 1', model: 'Model', version: '1', role: 'role' });
  return /^[A-Za-z0-9-]+: \S/.test(line);
}

// The version as a token of the display: no letter, digit or dot directly before or after it.
export function hasVersionToken(display: string, version: string): boolean {
  let from = 0;
  for (;;) {
    const at = display.indexOf(version, from);
    if (at < 0) return false;
    const before = display[at - 1] ?? '';
    const after = display[at + version.length] ?? '';
    if (!/[\p{L}\p{N}.]/u.test(before) && !/[\p{L}\p{N}.]/u.test(after)) return true;
    from = at + 1;
  }
}
