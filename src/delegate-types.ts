/**
 * A command an approved delegate pane may be allowed to run. `approve` is not one: approval is
 * the owner's, and a `commands` list naming it is a load error, never a delegation of it.
 */
export type DelegateCommand = 'up' | 'down' | 'add' | 'remove';

/** The four, in the order the documentation lists them. */
export const DELEGATE_COMMANDS: readonly DelegateCommand[] = ['up', 'down', 'add', 'remove'];

/** One approved pane and the commands it may run. `pane` is `<herdr session>/<pane id>`. */
export type Delegate = { pane: string; commands: DelegateCommand[] };

/**
 * The file's `delegates` section: null when absent. A non-empty list, at most eight entries,
 * two entries naming one pane refused; each entry's commands a non-empty list of distinct ones.
 */
export type Delegates = Delegate[] | null;
