import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Lifecycle behind "Edit excerpt…" in a PDF associated with LaTeX.
 *
 * Two-phase flow:
 * 1. Propose (`POST /api/latex/excerpt-edit/propose`): read-only ephemeral agent
 *    locates the passage (with SyncTeX hint when available) and returns a
 *    structured diff without writing to disk.
 * 2. Apply (`POST /api/latex/excerpt-edit/apply`): only after the user confirms
 *    the diff. Writes the file, syncs any open editor buffer, and recompiles
 *    with SyncTeX enabled.
 * 3. Revert (`POST /api/latex/excerpt-edit/revert`): one-click undo if the user
 *    changes their mind or the recompile fails.
 *
 * `state` is null or:
 *   { x, y, excerpt, source, instruction, status, proposal, applyResult,
 *     error, isReverting }
 * where `status` is:
 *   'compose' | 'loading' | 'review' | 'applying' | 'done' | 'error' | 'compile_error'
 */
export function useLatexExcerptEdit({
  model = '',
  projectPath = '',
  mainFile = '',
  isStandalonePdf = false,
  selectedPdfPath = '',
  unsavedFiles = null,
  onExternalFileUpdated,
  onCompiled,
} = {}) {
  const { t } = useTranslation();
  const [editState, setEditState] = useState(null);
  const requestRef = useRef(0);
  const stateRef = useRef(null);
  stateRef.current = editState;

  const isTargetUnsaved = useCallback((targetFile) => {
    if (!targetFile || !unsavedFiles) return false;
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const target = norm(targetFile);
    if (unsavedFiles instanceof Set) {
      for (const item of unsavedFiles) {
        if (norm(item) === target) return true;
      }
      return false;
    }
    if (Array.isArray(unsavedFiles)) {
      return unsavedFiles.some((item) => norm(item) === target);
    }
    return Boolean(unsavedFiles[targetFile]);
  }, [unsavedFiles]);

  const open = useCallback((excerpt, anchorPoint, source = {}) => {
    const text = String(excerpt || '').trim();
    if (!text) return;
    requestRef.current += 1;
    setEditState({
      x: anchorPoint?.x ?? 0,
      y: anchorPoint?.y ?? 0,
      excerpt: text,
      source,
      instruction: '',
      status: 'compose',
      proposal: null,
      applyResult: null,
      error: '',
      isReverting: false,
    });
  }, []);

  const setInstruction = useCallback((instruction) => {
    setEditState((prev) => (prev && prev.status === 'compose' ? { ...prev, instruction } : prev));
  }, []);

  const submitProposal = useCallback(async () => {
    const current = stateRef.current;
    const instruction = String(current?.instruction || '').trim();
    if (!current || !instruction || !projectPath) return;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setEditState((prev) => (prev ? {
      ...prev,
      status: 'loading',
      proposal: null,
      applyResult: null,
      error: '',
      isReverting: false,
    } : prev));

    try {
      const res = await fetch('/api/latex/excerpt-edit/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          excerpt: current.excerpt,
          instruction,
          model: model || '',
          projectPath,
          mainFile: mainFile || '',
          source: current.source || {},
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (requestRef.current !== requestId) return;
      if (!res.ok || !data.proposal) {
        throw new Error(data.error || res.statusText || 'Could not prepare LaTeX edit.');
      }
      setEditState((prev) => (prev ? {
        ...prev,
        status: 'review',
        proposal: data.proposal,
        error: '',
      } : prev));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setEditState((prev) => (prev ? {
        ...prev,
        status: 'error',
        error: err.message || String(err),
      } : prev));
    }
  }, [model, projectPath, mainFile]);

  const applyProposal = useCallback(async () => {
    const current = stateRef.current;
    const proposal = current?.proposal;
    if (!current || !proposal || !projectPath) return;

    if (isTargetUnsaved(proposal.targetFile)) {
      setEditState((prev) => (prev ? {
        ...prev,
        error: t(
          'latexExcerptEdit.unsavedTarget',
          '{{file}} has unsaved edits in the editor. Save or discard them before applying this change.',
          { file: proposal.targetFile },
        ),
      } : prev));
      return;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setEditState((prev) => (prev ? { ...prev, status: 'applying', error: '' } : prev));

    try {
      const res = await fetch('/api/latex/excerpt-edit/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          targetFile: proposal.targetFile,
          oldText: proposal.oldText,
          newText: proposal.newText,
          baseSha256: proposal.baseSha256,
          pdfPath: isStandalonePdf ? selectedPdfPath : '',
          mainFile: mainFile || '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (requestRef.current !== requestId) return;
      if (!res.ok) {
        throw new Error(data.error || res.statusText || 'Could not apply LaTeX edit.');
      }

      onExternalFileUpdated?.(data.targetFile || proposal.targetFile, data.newContent);

      const applyResult = {
        targetFile: data.targetFile || proposal.targetFile,
        compiledMainFile: data.compiledMainFile || '',
        compileSuccess: Boolean(data.compileSuccess),
        compileLog: data.compileLog || '',
        newContent: data.newContent,
        previousContent: data.previousContent,
        newSha256: data.newSha256 || '',
        startLine: data.startLine || proposal.startLine || 1,
        endLine: data.endLine || proposal.endLine || 1,
        pdfUrl: data.pdfUrl || '',
      };

      onCompiled?.(applyResult);

      setEditState((prev) => (prev ? {
        ...prev,
        status: applyResult.compileSuccess ? 'done' : 'compile_error',
        applyResult,
        error: applyResult.compileSuccess ? '' : (applyResult.compileLog || 'LaTeX compilation failed.'),
      } : prev));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setEditState((prev) => (prev ? {
        ...prev,
        status: 'review',
        error: err.message || String(err),
      } : prev));
    }
  }, [
    projectPath,
    isStandalonePdf,
    selectedPdfPath,
    mainFile,
    isTargetUnsaved,
    onExternalFileUpdated,
    onCompiled,
    t,
  ]);

  const revertApplied = useCallback(async () => {
    const current = stateRef.current;
    const applied = current?.applyResult;
    if (!current || !applied || !projectPath || current.isReverting) return;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setEditState((prev) => (prev ? { ...prev, isReverting: true, error: '' } : prev));

    try {
      const res = await fetch('/api/latex/excerpt-edit/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          targetFile: applied.targetFile,
          expectedSha256: applied.newSha256,
          previousContent: applied.previousContent,
          pdfPath: isStandalonePdf ? selectedPdfPath : '',
          mainFile: mainFile || '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (requestRef.current !== requestId) return;
      if (!res.ok) {
        throw new Error(data.error || res.statusText || 'Could not revert LaTeX edit.');
      }

      onExternalFileUpdated?.(data.targetFile || applied.targetFile, data.newContent);
      onCompiled?.({
        targetFile: data.targetFile || applied.targetFile,
        compiledMainFile: data.compiledMainFile || '',
        compileSuccess: Boolean(data.compileSuccess),
        compileLog: data.compileLog || '',
        pdfUrl: data.pdfUrl || '',
        startLine: applied.startLine || 1,
        reverted: true,
      });

      setEditState((prev) => (prev ? {
        ...prev,
        status: 'compose',
        proposal: null,
        applyResult: null,
        error: '',
        isReverting: false,
      } : prev));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setEditState((prev) => (prev ? {
        ...prev,
        isReverting: false,
        error: err.message || String(err),
      } : prev));
    }
  }, [projectPath, isStandalonePdf, selectedPdfPath, mainFile, onExternalFileUpdated, onCompiled]);

  const compose = useCallback((keepInstruction = true) => {
    requestRef.current += 1;
    setEditState((prev) => (prev ? {
      ...prev,
      status: 'compose',
      instruction: keepInstruction ? prev.instruction : '',
      proposal: null,
      applyResult: null,
      error: '',
      isReverting: false,
    } : prev));
  }, []);

  const close = useCallback(() => {
    requestRef.current += 1;
    setEditState(null);
  }, []);

  return {
    editState,
    open,
    setInstruction,
    submitProposal,
    applyProposal,
    revertApplied,
    compose,
    close,
  };
}

export default useLatexExcerptEdit;
