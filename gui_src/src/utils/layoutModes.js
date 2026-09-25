// Which layout modes keep the editor and its preview on screen.
//
// Three of them do: `ide`, `studio` and `document`. The chat-first layouts
// (`chat`, `chat-bottom`) put a conversation where the editor would be, and
// `review` puts the checkpoint sidebar there. Two rules read off that one list,
// which is why it lives here rather than being spelled out at each call site:
//
//   - those layouts dock the explorer/source-control sidebar, so opening the
//     explorer from one of them must not switch the user to another layout
//     (`ActivityBar`'s `hasDockedSidebar`);
//   - opening a file only has to leave the layouts that hide the editor
//     (`App.jsx`'s `revealEditorLayout`), so picking a file in the explorer
//     never drops the user out of the studio or the document layout — which,
//     in the document layout, would mean leaving it for the very file it
//     exists to show.

export const EDITOR_LAYOUTS = ['ide', 'studio', 'document'];

const EDITOR_LAYOUT_SET = new Set(EDITOR_LAYOUTS);

/** Does `mode` render the editor panel? */
export const layoutShowsEditor = (mode) => EDITOR_LAYOUT_SET.has(mode);

/**
 * The layout to be in after a file is opened: the current one when it already
 * shows the editor, and the IDE layout otherwise.
 */
export const layoutAfterOpeningFile = (mode) => (layoutShowsEditor(mode) ? mode : 'ide');

// Layouts that do not render the chat as a toggleable panel: the chat-first
// ones (where the chat *is* the layout and cannot be hidden) and the document
// layout, which is only the file and its preview. The chat button and its
// Ctrl+T shortcut have nothing to switch in any of them.
const CHAT_TOGGLE_DISABLED_LAYOUTS = new Set(['chat', 'chat-bottom', 'document']);

/** Can the chat panel be shown/hidden in `mode`? */
export const layoutAllowsChatToggle = (mode) => !CHAT_TOGGLE_DISABLED_LAYOUTS.has(mode);

// The chat-first layouts dock their own left sidebar — the chat list above the
// workspace explorer — instead of the explorer/source-control one. It is
// retractable like every docked sidebar, and the Explorer button of the
// Activity Bar is what shows and hides it, so in these layouts that button
// toggles it in place rather than switching the user to the IDE layout.
const CHAT_SIDEBAR_LAYOUTS = new Set(['chat', 'chat-bottom']);

/** Does `mode` dock the chat-list + explorer sidebar? */
export const layoutHasChatSidebar = (mode) => CHAT_SIDEBAR_LAYOUTS.has(mode);
