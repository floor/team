import { renderSignature } from '../file/signature.ts';
import type { SeatIdentity } from './config.ts';

const PLACEHOLDER = /\{(display|role|model|version)\}/g;

/** The signature line a seat writes, from the project's template. */
export function render(template: string, seat: SeatIdentity): string {
  return renderSignature(template, seat).trimEnd();
}

/** Every accepted signature line. */
export function renderings(template: string, ledger: readonly SeatIdentity[]): Set<string> {
  return new Set(ledger.map((seat) => render(template, seat)));
}

/**
 * Matches a line that has the template's fixed words around any values: a
 * signature by its form, whether or not a seat ever had those values.
 */
export function shape(template: string): RegExp {
  const literals = template
    .trimEnd()
    .split(PLACEHOLDER)
    .filter((_, index) => index % 2 === 0);
  const escaped = literals.map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('(.+?)')}$`);
}
