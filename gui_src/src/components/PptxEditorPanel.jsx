/**
 * PptxEditorPanel
 *
 * Thin bridge between the OpalaTex IDE shell and pptx-react-viewer. The viewer
 * owns presentation navigation, thumbnails, presentation mode, and editing UI;
 * this component only loads and saves the binary file through the local server.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PowerPointViewer, vermilionDarkTheme, vermilionLightTheme } from 'pptx-react-viewer';
import 'pptx-react-viewer/styles';

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const HIDDEN_VIEWER_ACTIONS = [
  'file',
  'share',
  'broadcast',
  'record',
  'export',
  'notes',
  'fullscreen',
  'help',
  'insert',
  'draw',
  'design',
  'transitions',
  'animations',
  'slideShow',
  'review',
  'view',
];

const PptxEditorPanel = forwardRef(function PptxEditorPanel({
  activeProject,
  selectedFile,
  theme,
  onSaved,
}, ref) {
  const { t } = useTranslation();
  const [documentBuffer, setDocumentBuffer] = useState(undefined);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [docVersion, setDocVersion] = useState(0);
  const [autosaveEnabled, setAutosaveEnabled] = useState(true);
  const viewerRef = useRef(null);

  const saveBuffer = useCallback(async (buffer) => {
    if (!activeProject?.project_path || !selectedFile || !buffer) return false;

    const blob = new Blob([buffer], { type: PPTX_MIME });
    const form = new FormData();
    form.append('projectPath', activeProject.project_path);
    form.append('filePath', selectedFile);
    form.append(
      'file',
      blob,
      selectedFile.replace(/\\/g, '/').split('/').pop() || 'presentation.pptx',
    );

    const response = await fetch('/api/file/write-binary', {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return true;
  }, [activeProject?.project_path, selectedFile]);

  useEffect(() => {
    let cancelled = false;
    setDocumentBuffer(undefined);
    setLoadError('');
    setStatus(t('pptxEditor.loading', 'Loading presentation...'));

    async function loadPptx() {
      if (!activeProject?.project_path || !selectedFile) return;
      try {
        const params = new URLSearchParams({
          projectPath: activeProject.project_path,
          filePath: selectedFile,
          t: String(Date.now()),
        });
        const response = await fetch(`/api/file/raw?${params.toString()}`);
        if (!response.ok) {
          const message = await response.text().catch(() => '');
          throw new Error(message || `HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        if (cancelled) return;
        setDocumentBuffer(buffer);
        setDocVersion((v) => v + 1);
        setStatus('');
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setStatus('');
      }
    }

    loadPptx();
    return () => {
      cancelled = true;
    };
  }, [activeProject?.project_path, selectedFile, t]);

  useEffect(() => {
    if (!documentBuffer) return undefined;
    let cancelled = false;

    const settleViewer = () => {
      if (cancelled) return;
      viewerRef.current?.setMode?.('edit');
      viewerRef.current?.goTo?.(0);
    };

    const timer = window.setTimeout(settleViewer, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [documentBuffer, docVersion]);

  const handleSave = useCallback(async (bufferOverride) => {
    if (!activeProject?.project_path || !selectedFile) return false;

    setStatus(t('pptxEditor.saving', 'Saving presentation...'));

    try {
      const buffer = bufferOverride || await viewerRef.current?.getContent?.();
      if (!buffer) throw new Error('The presentation viewer did not return file content.');
      await saveBuffer(buffer);

      setStatus(t('pptxEditor.saved', 'Presentation saved.'));
      setTimeout(() => setStatus(''), 2000);
      onSaved?.(selectedFile);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(t('pptxEditor.saveFailed', 'Could not save presentation: {{error}}', { error: message }));
      return false;
    }
  }, [activeProject?.project_path, selectedFile, onSaved, saveBuffer, t]);

  const handleAutosaveContent = useCallback(async (buffer) => {
    if (!autosaveEnabled) return;
    setStatus(t('pptxEditor.saving', 'Saving presentation...'));
    try {
      await saveBuffer(buffer);
      setStatus(t('pptxEditor.saved', 'Presentation saved.'));
      setTimeout(() => setStatus(''), 2000);
      onSaved?.(selectedFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(t('pptxEditor.saveFailed', 'Could not save presentation: {{error}}', { error: message }));
      throw error;
    }
  }, [autosaveEnabled, onSaved, saveBuffer, selectedFile, t]);

  useImperativeHandle(ref, () => ({
    save: () => handleSave(),
  }), [handleSave]);

  const colorMode = theme === 'light' ? 'light' : 'dark';
  const fileName = selectedFile?.replace(/\\/g, '/').split('/').pop() || 'presentation.pptx';
  const viewerTheme = colorMode === 'light' ? vermilionLightTheme : vermilionDarkTheme;
  const viewerContent = useMemo(() => (
    documentBuffer ? new Uint8Array(documentBuffer) : null
  ), [documentBuffer]);

  if (loadError) {
    return (
      <div className="pptx-editor-host pptx-editor-error">
        <p>
          {t('pptxEditor.loadFailed', 'Could not load presentation: {{error}}', {
            error: loadError,
          })}
        </p>
      </div>
    );
  }

  if (documentBuffer === undefined) {
    return (
      <div className="pptx-editor-host pptx-editor-loading">
        <RefreshCw size={18} className="animate-spin" />
        <span>{status || t('pptxEditor.loading', 'Loading presentation...')}</span>
      </div>
    );
  }

  return (
    <div className={`opalatex-pptx-viewer-host ${colorMode}`}>
      <div className="opalatex-pptx-viewer-frame">
        <PowerPointViewer
          key={docVersion}
          ref={viewerRef}
          content={viewerContent}
          filePath={selectedFile}
          fileName={fileName}
          canEdit
          theme={viewerTheme}
          onDirtyChange={() => {}}
          onAutosaveContent={handleAutosaveContent}
          autosaveEnabled={autosaveEnabled}
          autosaveIntervalSeconds={5}
          onAutosaveEnabledChange={setAutosaveEnabled}
          onOpenFile={() => {}}
          hiddenActions={HIDDEN_VIEWER_ACTIONS}
        />
      </div>
    </div>
  );
});

export default PptxEditorPanel;
