import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DocxEditor } from '@docx-editor.dev/react';
import enDocxLocale from '../../vendor/docx-editor/i18n/en';
import ptBRDocxLocale from '../../vendor/docx-editor/i18n/pt-BR';
import '../../vendor/docx-editor/react/styles/editor.compiled.css';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export default function DocxEditorPanel({
  activeProject,
  selectedFile,
  theme,
  onSaved,
}) {
  const { t, i18n } = useTranslation();
  const editorRef = useRef(null);
  const [documentBuffer, setDocumentBuffer] = useState(undefined);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [docVersion, setDocVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDocumentBuffer(undefined);
    setLoadError('');
    setStatus(t('docxEditor.loading', 'Loading DOCX...'));

    async function loadDocx() {
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
        setDocVersion((value) => value + 1);
        setStatus('');
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setStatus('');
      }
    }

    loadDocx();
    return () => {
      cancelled = true;
    };
  }, [activeProject?.project_path, selectedFile, t]);

  const saveBuffer = useCallback(async (buffer) => {
    if (!activeProject?.project_path || !selectedFile || !buffer) return false;

    const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type: DOCX_MIME });
    const form = new FormData();
    form.append('projectPath', activeProject.project_path);
    form.append('filePath', selectedFile);
    form.append('file', blob, selectedFile.replace(/\\/g, '/').split('/').pop() || 'document.docx');

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

  const handleSave = useCallback(async (bufferFromEditor = null) => {
    if (!editorRef.current && !bufferFromEditor) return;
    setIsSaving(true);
    setStatus(t('docxEditor.saving', 'Saving DOCX...'));
    try {
      const buffer = bufferFromEditor || await editorRef.current.save();
      await saveBuffer(buffer);
      setStatus(t('docxEditor.saved', 'DOCX saved.'));
      onSaved?.(selectedFile);
      setTimeout(() => setStatus(''), 2000);
    } catch (error) {
      setStatus(t('docxEditor.saveFailed', 'DOCX save failed: {{error}}', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setIsSaving(false);
    }
  }, [onSaved, saveBuffer, selectedFile, t]);

  const fileName = selectedFile?.replace(/\\/g, '/').split('/').pop() || 'document.docx';
  const colorMode = theme === 'light' ? 'light' : 'dark';
  const editorLocale = useMemo(() => {
    const language = i18n.resolvedLanguage || i18n.language || 'en';
    return language.toLowerCase().startsWith('pt') ? ptBRDocxLocale : enDocxLocale;
  }, [i18n.language, i18n.resolvedLanguage]);

  if (loadError) {
    return (
      <div className="docx-editor-host docx-editor-empty">
        <p>{t('docxEditor.loadFailed', 'Could not load DOCX: {{error}}', { error: loadError })}</p>
      </div>
    );
  }

  if (documentBuffer === undefined) {
    return (
      <div className="docx-editor-host docx-editor-empty">
        <RefreshCw size={18} className="animate-spin" />
        <span>{status || t('docxEditor.loading', 'Loading DOCX...')}</span>
      </div>
    );
  }

  return (
    <div className="docx-editor-host">
      <DocxEditor
        key={docVersion}
        ref={editorRef}
        documentBuffer={documentBuffer}
        author="OpalaTex"
        colorMode={colorMode}
        documentName={fileName}
        i18n={editorLocale}
        showFileOpen={false}
        showHelpMenu={false}
        showToolbar
        showRuler
        showZoomControl
        onSave={(buffer) => handleSave(buffer)}
        onError={(error) => {
          setStatus(t('docxEditor.editorError', 'DOCX editor error: {{error}}', { error: error.message }));
        }}
        renderTitleBarRight={() => (
          <div className="docx-editor-actions">
            {status && <span className="docx-editor-status">{status}</span>}
            <button
              type="button"
              className="vscode-button"
              onClick={() => handleSave()}
              disabled={isSaving}
              title={t('docxEditor.save', 'Save DOCX')}
            >
              {isSaving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
            </button>
          </div>
        )}
      />
    </div>
  );
}
