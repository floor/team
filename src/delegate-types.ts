/** A command an approved delegate pane may be allowed to run. */
export type DelegateCommand = 'up' | 'down' | 'add' | 'remove' | 'approve';

/** The five, in the order the documentation lists them. */
export const DELEGATE_COMMANDS: readonly DelegateCommand[] = ['up', 'down', 'add', 'remove', 'approve'];

/** The file's `delegate` section: null when absent. `pane` is `<herdr session>/<pane id>`. */
export type Delegate = { pane: string; commands: DelegateCommand[] } | null;
