# Walkthrough: PPTX Editor & Viewer Implementation

## Summary

Implemented a fully vendored PowerPoint (.pptx) editor and viewer integrated into the OpalaTex IDE. The editor renders slides as interactive HTML/CSS elements, supports text editing, element selection, slide management (add/duplicate/delete/reorder), undo/redo, and saves modifications back to valid PPTX files.

---

## Changes Made

### New Dependencies
- `framer-motion` and `fast-xml-parser` added to [package.json](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/package.json)

### Vendored Core Library (`gui_src/vendor/pptx-editor/core/`)

| File | Purpose |
|:-----|:--------|
| [types.ts](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/core/types.ts) | TypeScript interfaces for the entire slide model (Presentation, Slide, Shape, Picture, TextBody, Transform, etc.) using EMU coordinates |
| [parser.ts](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/core/parser.ts) | Parses PPTX `ArrayBuffer` via JSZip → extracts slide ordering, elements (shapes, pictures, groups, tables), text formatting, colors, and resolves embedded images to data URIs |
| [serializer.ts](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/core/serializer.ts) | Surgical-update serializer that only regenerates modified slide XMLs, preserving all unmodified ZIP entries for lossless round-tripping |
| [index.ts](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/core/index.ts) | Public barrel exports |

### Vendored React UI (`gui_src/vendor/pptx-editor/react/`)

| File | Purpose |
|:-----|:--------|
| [PptxEditor.jsx](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/react/PptxEditor.jsx) | Main editor component: orchestrates toolbar + sidebar + canvas, manages undo/redo, slide CRUD, element selection, keyboard shortcuts |
| [SlideCanvas.jsx](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/react/components/SlideCanvas.jsx) | Renders a single slide with all elements (shapes, pictures, groups, tables), supports selection handles, inline `contentEditable` text editing, auto-scaling |
| [SlideThumbnailSidebar.jsx](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/react/components/SlideThumbnailSidebar.jsx) | Slide thumbnail list with click-to-select, drag-to-reorder, right-click context menu |
| [SlideToolbar.jsx](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/react/components/SlideToolbar.jsx) | Formatting toolbar: save, undo/redo, bold/italic/underline, alignment, insert shapes/text/images, zoom, presenter mode |
| [editor.css](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/react/styles/editor.css) | Complete CSS with light/dark theme support via CSS custom properties |
| [index.ts](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vendor/pptx-editor/react/index.ts) | Public barrel exports |

### App Integration

| File | Change |
|:-----|:-------|
| [vite.config.js](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/vite.config.js) | Added Vite resolve aliases for `@pptx-editor/core` and `@pptx-editor/react` |
| [PptxEditorPanel.jsx](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/src/components/PptxEditorPanel.jsx) | **[NEW]** Bridge component: fetches PPTX binary from `/api/file/raw`, mounts `PptxEditor`, saves via `/api/file/write-binary` |
| [EditorPanel.jsx](file:///c:/Users/gilza/projetos/OpalaTex/gui_src/src/components/EditorPanel.jsx) | Added `isPptxFile` detection, lazy import of `PptxEditorPanel`, and `<Suspense>` wrapper rendering |

---

## What Was Tested
- ✅ **Vite production build** passes cleanly with no errors or warnings.
- The PPTX editor component is lazy-loaded only when a `.pptx` file is selected, so it has zero impact on the main bundle load time.

## Next Steps (Manual Verification)
1. Open the OpalaTex IDE and create or import a `.pptx` file.
2. Click the file in the explorer to open it in the editor.
3. Verify slides render with correct text, shapes, and images.
4. Test editing: double-click text to edit, click to select elements, use toolbar buttons.
5. Test slide management: add, duplicate, delete, and drag-to-reorder slides.
6. Save and re-open the file in Microsoft PowerPoint or Google Slides to verify compatibility.
