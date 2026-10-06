/**
 * A command an approved delegate pane may be allowed to run. `approve` is not one: approval is
 * the owner's, and a `commands` list naming it is a load error, never a delegation of it.
 */
export type DelegateCommand = 'up' | 'down' | 'add' | 'remove';

/** The four, in the order the documentation lists them. */
export const DELEGATE_COMMANDS: readonly DelegateCommand[] = ['up', 'down', 'add', 'remove'];

/** The power word a `commands` list may hold beside a command: it grants nothing by itself. */
export const ABANDON = 'abandon';

/** One word of a `commands` list: one of the four commands, or the power word `abandon`. */
export type DelegateWord = DelegateCommand | typeof ABANDON;

/** The four commands and the word, the vocabulary a `commands` list may hold. */
export const DELEGATE_WORDS: readonly DelegateWord[] = [...DELEGATE_COMMANDS, ABANDON];

/** One approved pane and the words it may hold. `pane` is `<herdr session>/<pane id>`. */
export type Delegate = { pane: string; commands: DelegateWord[] };

/**
 * The file's `delegates` section: null when absent. A non-empty list, at most eight entries,
 * two entries naming one pane refused; each entry's commands a non-empty ordered list of
 * distinct commands and words.
 */
export type Delegates = Delegate[] | null;
