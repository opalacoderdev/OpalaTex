/**
 * PptxEditorPanel
 *
 * Bridge component between the OpalaTex IDE shell (EditorPanel) and the
 * vendored PPTX editor.  Handles fetching the binary file from the server,
 * mounting the editor, and writing saved buffers back.
 *
 * This mirrors DocxEditorPanel.jsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PptxEditor } from '@pptx-editor/react';
import '../../vendor/pptx-editor/react/styles/editor.css';

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export default function PptxEditorPanel({
  activeProject,
  selectedFile,
  theme,
  onSaved,
}) {
  const { t } = useTranslation();
  const [documentBuffer, setDocumentBuffer] = useState(undefined);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [docVersion, setDocVersion] = useState(0);

  // ── Load the PPTX binary ────────────────────────────────────────────────
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

  // ── Save handler ────────────────────────────────────────────────────────
  const handleSave = useCallback(
    async (buffer) => {
      if (!activeProject?.project_path || !selectedFile || !buffer) return;

      const blob =
        buffer instanceof Blob
          ? buffer
          : new Blob([buffer], { type: PPTX_MIME });

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
      onSaved?.(selectedFile);
    },
    [activeProject?.project_path, selectedFile, onSaved],
  );

  // ── Error handler ───────────────────────────────────────────────────────
  const handleError = useCallback(
    (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      setStatus(
        t('pptxEditor.editorError', 'Presentation editor error: {{error}}', {
          error: msg,
        }),
      );
    },
    [t],
  );

  const colorMode = theme === 'light' ? 'light' : 'dark';

  // ── Render states ───────────────────────────────────────────────────────
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
        <span>
          {status || t('pptxEditor.loading', 'Loading presentation...')}
        </span>
      </div>
    );
  }

  return (
    <PptxEditor
      key={docVersion}
      documentBuffer={documentBuffer}
      colorMode={colorMode}
      onSave={handleSave}
      onError={handleError}
    />
  );
}
