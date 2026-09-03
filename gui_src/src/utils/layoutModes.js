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
