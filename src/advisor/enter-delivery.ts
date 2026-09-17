/**
 * Enter-to-deliver: the release affordance for a queued advisory in an idle
 * chat.
 *
 * Pi drops an empty Enter inside the TUI submit guard, before any extension
 * `input` event fires — so a preserved advisory can sit in the inbox with no
 * way to say "go ahead" short of typing a real prompt. The interception point
 * is the editor itself: pi's TUI routes terminal input to exactly one focused
 * component, so the editor's input handler only ever sees a keystroke that
 * dialogs, model pickers, and other overlays did not claim. Delivering from
 * there cannot steal an Enter from anything else, which a raw-terminal-input
 * listener (`ctx.ui.onTerminalInput`) genuinely could — it runs before focus
 * routing and would have eaten built-in picker selection keys.
 *
 * The interception is still deliberately narrow and fail-closed: the editor's
 * own submit binding must match (user-rebound keys respected), autocomplete
 * must be closed, submission must be enabled, and the session state must be
 * exactly the empty-chat-with-something-queued case. Everything else falls
 * through to the editor untouched.
 */

export interface EnterDeliveryState {
  /** Whether the primary agent is idle (`ctx.isIdle`). */
  idle: boolean;
  /** Whether the advisor is paused. */
  paused: boolean;
  /** How many advisories are waiting in the inbox. */
  queued: number;
}

export interface EnterDeliverySignal extends EnterDeliveryState {
  /** Whether the byte sequence matches the editor's own submit binding. */
  isSubmitKey: boolean;
  /** Current editor contents. */
  editorText: string;
  /** Whether the editor is currently showing its autocomplete popup. */
  autocompleteOpen: boolean;
  /** Whether the editor has submission disabled (pi's own gate). */
  submitDisabled: boolean;
}

/** Whether a submit keypress on an empty editor should release the queued inbox now. */
export function shouldDeliverQueuedOnEnter(signal: EnterDeliverySignal): boolean {
  return (
    signal.isSubmitKey &&
    !signal.autocompleteOpen &&
    !signal.submitDisabled &&
    !signal.paused &&
    signal.idle &&
    signal.queued > 0 &&
    signal.editorText.trim().length === 0
  );
}

/** The subset of an editor the interception needs. `CustomEditor` (and any editor extending it) satisfies this. */
export interface EnterDeliveryEditor {
  handleInput(data: string): void;
  getText(): string;
  isShowingAutocomplete?(): boolean;
  disableSubmit?: boolean;
}

export interface EnterDeliveryAttachment {
  /** Match a raw byte sequence against the editor's own submit keybinding. */
  isSubmitKey: (data: string) => boolean;
  /** Live session state, read at keypress time. */
  state: () => EnterDeliveryState;
  /** Release the queued inbox and start the turn. */
  deliver: () => void;
}

/**
 * Attach Enter-to-deliver to one editor instance by wrapping its input
 * handler. Everything but the exact deliver case passes through untouched.
 * Compose-friendly: wrapping an already-wrapped or third-party custom editor
 * works, since only `handleInput` is replaced and it delegates for every other
 * input.
 */
export function attachEnterDelivery<T extends EnterDeliveryEditor>(editor: T, attachment: EnterDeliveryAttachment): T {
  const original = editor.handleInput.bind(editor);
  editor.handleInput = (data: string): void => {
    if (
      shouldDeliverQueuedOnEnter({
        isSubmitKey: attachment.isSubmitKey(data),
        editorText: editor.getText(),
        autocompleteOpen: editor.isShowingAutocomplete?.() ?? false,
        submitDisabled: editor.disableSubmit ?? false,
        ...attachment.state(),
      })
    ) {
      attachment.deliver();
      // Consumed: the default empty-submit path is a no-op in pi's pipeline,
      // so nothing is lost by keeping the byte from the editor.
      return;
    }
    original(data);
  };
  return editor;
}
