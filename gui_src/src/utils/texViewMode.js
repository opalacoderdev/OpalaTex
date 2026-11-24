// Decides whether an open `.tex` tab renders in PDF-only view.
//
// When the user enables `openTexInPdfView` (Settings > General), opening a
// `.tex` file that already has a compiled PDF shows that PDF full-width
// instead of the raw LaTeX source, while keeping the tab anchored on the
// `.tex` file so SyncTeX, agent compile reloads, and the "View code" toggle
// all work without switching tabs.
//
// An explicit per-file override ('code' or 'pdf') always wins over the default
// preference so switching tabs and coming back never overrides what the user
// just asked to see.

export function shouldShowTexPdfOnly({
  isTexFile = false,
  openTexInPdfView = 'on',
  hasPdf = false,
  hasCompileError = false,
  explicitMode = null, // 'pdf' | 'code' | null
  isRichTextMode = false,
  isWysiwygMode = false,
  isDiffMode = false,
} = {}) {
  if (!isTexFile || !hasPdf || hasCompileError) return false;
  if (isRichTextMode || isWysiwygMode || isDiffMode) return false;
  if (explicitMode === 'code') return false;
  if (explicitMode === 'pdf') return true;
  return openTexInPdfView === 'on';
}
