# Monaco Editor Context Menu — Hover Highlight Offset Bug

## Problem

The Monaco Editor (v0.55.1) context menu has a **hover highlight misalignment**: the visual highlight (`.focused` class) appears on a different item than the one the mouse cursor is over. The offset is approximately **1 item** and affects items that appear **after 2+ separators** in the menu.

### Symptoms

- Right-click in the editor → context menu appears
- Mouse over "Generate Content" → "Create Illustration" is highlighted instead (1 item above)
- **Clicking works correctly** — only the visual highlight is wrong
- Native Monaco items (Cut, Copy, Paste) near the top are fine
- Custom items added via `editor.addAction()` further down the list are affected

### Root Cause

Monaco v0.55+ renders the context menu inside a **Shadow DOM** (`<div class="shadow-root-host">`). Inside the Shadow DOM:

- Regular menu items are **26px** tall
- Separator items (`.action-item.disabled` with `.separator` child) are **11px** tall
- Monaco's internal scroll widget assumes **uniform item heights** for mouse tracking
- After each separator, the tracking accumulates an error of `26 - 11 = 15px`
- After **2 separators**, the error is **30px ≈ 1 item**, causing the highlight to shift up by one

### Why CSS Fixes Don't Work

1. **External CSS cannot penetrate Shadow DOM** — rules in `index.css` targeting `.monaco-menu`, `.context-view`, etc. have **zero effect** on the menu elements because they live inside a shadow root.

2. **`:has()` selector** may not be supported in Qt WebEngine (used by pywebview).

3. **JavaScript DOM manipulation** (setting `style.minHeight` on separator `<li>` elements via `MutationObserver`) runs **after** Monaco has already cached the item positions, so the offset persists even if the visual height changes.

## Solution

**Replace Monaco's built-in context menu entirely** with a custom HTML/CSS menu rendered in the normal DOM.

### Implementation

#### 1. Disable Monaco's built-in context menu

Add `contextmenu: false` to **all** `<Editor>` and `<DiffEditor>` options:

```jsx
<Editor
  options={{
    contextmenu: false,   // ← Disables Monaco's Shadow DOM menu
    // ... other options
  }}
/>
```

#### 2. Create a custom context menu component

File: `gui_src/src/components/EditorContextMenuOverlay.jsx`

- Renders a `<div>` with `position: fixed` at the click coordinates
- Contains `<button>` elements for each menu item (Cut, Copy, Paste, Refine, Generate, etc.)
- Uses standard CSS `:hover` for highlighting — no Shadow DOM, no offset bugs
- Closes on click outside or Escape key

#### 3. Attach the context menu listener to a stable container

**Critical**: The listener must be attached to the **panel container div** (not the Monaco editor DOM node), because:

- The editor DOM node is destroyed/recreated when switching between split view (`.tex` files) and non-split view
- The editor `onMount` callback only fires once per editor instance
- The panel container div persists across file switches

```jsx
// In EditorPanel.jsx
const editorContainerRef = useRef(null);
const localEditorRef = useRef(null);
const monacoRef = useRef(null);

// Attach listener via useEffect with selectedFile dependency
useEffect(() => {
  const container = editorContainerRef.current;
  if (!container) return;

  const handleContextMenu = (e) => {
    const ed = localEditorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    // Only intercept right-clicks inside the editor area
    const editorDom = ed.getDomNode();
    if (!editorDom || !editorDom.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();
    // ... show custom menu with editor state
  };

  container.addEventListener('contextmenu', handleContextMenu, true);
  return () => container.removeEventListener('contextmenu', handleContextMenu, true);
}, [selectedFile]);  // ← Must depend on selectedFile!
```

**Why `[selectedFile]`?** The component does an early return when `selectedFile` is null, rendering a different JSX tree. The container `ref` is only populated when `selectedFile` exists. With `[]`, the `useEffect` runs on first mount when the ref is still `null`.

#### 4. Update handleMount to store monaco ref

```jsx
const handleMount = (editor, monaco) => {
  const actualEditor = isDiff ? editor.getModifiedEditor() : editor;
  localEditorRef.current = actualEditor;
  monacoRef.current = monaco;  // ← Store for the context menu handler
  // ...
};
```

### Files Modified

| File | Change |
|------|--------|
| `gui_src/src/components/EditorPanel.jsx` | Disabled Monaco menu, added container ref, useEffect listener, monacoRef |
| `gui_src/src/components/EditorContextMenuOverlay.jsx` | **[NEW]** Custom context menu component |
| `gui_src/src/index.css` | Added `.editor-ctx-menu` styles (VS Code dark theme look) |

### Diagnostic Process (for reference)

The diagnosis required **6 iterations** because:

1. Standard DOM queries (`querySelectorAll`) couldn't find the menu (it's in Shadow DOM)
2. `MutationObserver` on `document.body` missed the menu (Shadow DOM boundary)
3. `contextmenu` event didn't reach `document` (Monaco calls `stopPropagation`)
4. Capture-phase listener found the wrong element (editor gutter matched first)
5. **Key breakthrough**: finding `<div class="shadow-root-host">` with `shadowRoot.mode = "open"`
6. Inspecting inside Shadow DOM revealed uniform `box-sizing: content-box` and 11px separators

**Lesson**: When debugging Monaco widget issues, always check for Shadow DOM first:
```javascript
document.querySelectorAll('*').forEach(el => {
  if (el.shadowRoot) console.log('Shadow root:', el.className);
});
```
