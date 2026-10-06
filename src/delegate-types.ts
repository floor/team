/** A command an approved delegate pane may be allowed to run. */
export type DelegateCommand = 'up' | 'down' | 'add' | 'remove' | 'approve';

/** The five, in the order the documentation lists them. */
export const DELEGATE_COMMANDS: readonly DelegateCommand[] = ['up', 'down', 'add', 'remove', 'approve'];

/** One approved pane and the commands it may run. `pane` is `<herdr session>/<pane id>`. */
export type Delegate = { pane: string; commands: DelegateCommand[] };

/**
 * The file's `delegates` section: null when absent. A non-empty list, at most eight entries,
 * two entries naming one pane refused; each entry's commands a non-empty list of distinct ones.
 */
export type Delegates = Delegate[] | null;
