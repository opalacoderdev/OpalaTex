import { useRef, useEffect, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { Files, RefreshCw, Check, X, Maximize2, Minimize2, GitCompare, Eye, EyeOff, Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getLanguage } from '../utils/language';
import InlinePromptOverlay from './InlinePromptOverlay';
import { formatMessageContent } from '../utils/formatMessage';
import Split from 'react-split';
import PdfPreview from './PdfPreview';

// Center panel: file tabs + Monaco editor (or empty state when no file is open).
export default function EditorPanel({
  selectedFile,
  openFiles,
  fileContent,
  fileContents,
  originalFileContents,
  isSaving,
  theme,
  editorFontSize,
  editorTabSize,
  editorWordWrap,
  handleFileSelect,
  handleCloseTab,
  saveFile,
  handleEditorDidMount,
  setFileContent,
  isMaximized,
  onToggleMaximize,
  // Inline prompt props
  inlinePrompt,
  setInlinePrompt,
  onInlineSubmit,
  isInlineRunning,
  onInlineCancel,
  onToggleTerminal,
  activeProject,
  jumpToLine,
  setJumpToLine,
}) {
  const { t } = useTranslation();
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  
  const isPdfFile = selectedFile && selectedFile.toLowerCase().endsWith('.pdf');
  const isTexRelatedFile = (filename) => {
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return ['tex', 'cls', 'sty', 'bib'].includes(ext);
  };
  const isTexFile = isTexRelatedFile(selectedFile);

  // PDF state
  const [pdfBase64, setPdfBase64] = useState(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [pdfErrorLog, setPdfErrorLog] = useState('');
  const [isTectonicAvailable, setIsTectonicAvailable] = useState(true);

  const checkTectonic = () => {
    fetch('/api/latex/check-tectonic')
      .then(r => r.json())
      .then(data => setIsTectonicAvailable(data.found))
      .catch(() => {});
  };

  useEffect(() => {
    checkTectonic();
    window.addEventListener('focus', checkTectonic);
    return () => window.removeEventListener('focus', checkTectonic);
  }, []);

  // Clear PDF only when switching projects
  const prevProjectRef = useRef(activeProject?.project_path);
  useEffect(() => {
    if (activeProject?.project_path !== prevProjectRef.current) {
      setPdfBase64(null);
      setPdfErrorLog('');
      prevProjectRef.current = activeProject?.project_path;
    }
  }, [activeProject?.project_path]);

  // ── Restore or compile ──────────────────────────────────────────────────
  useEffect(() => {
    setIsDiffMode(false);
    setIsPreviewMode(false);
    
    // Check if there is an existing PDF for this file
    if (selectedFile && selectedFile.toLowerCase().endsWith('.tex') && activeProject?.project_path) {
      fetch(`/api/latex/check-pdf?filePath=${encodeURIComponent(selectedFile)}&projectPath=${encodeURIComponent(activeProject.project_path)}`)
        .then(r => r.json())
        .then(data => {
          if (data.found && data.pdf_base64) {
            setPdfBase64(data.pdf_base64);
            setPdfErrorLog('');
          }
          // If not found, do NOT clear pdfBase64, so the main document's PDF remains visible
          // when clicking into an included file (e.g., apendice.tex).
        })
        .catch(() => {});
    }
    // We also do NOT clear pdfBase64 if not a .tex file, 
    // so users can see the PDF while editing .bib or .cls files.
  }, [selectedFile, activeProject?.project_path]);

  // Jump to line effect when switching files
  useEffect(() => {
    if (jumpToLine && jumpToLine.file === selectedFile && localEditorRef.current) {
      // Small delay to ensure editor is mounted and file is loaded
      setTimeout(() => {
        if (localEditorRef.current) {
          localEditorRef.current.revealLineInCenter(jumpToLine.line);
          localEditorRef.current.setPosition({ lineNumber: jumpToLine.line, column: 1 });
          localEditorRef.current.focus();
        }
        setJumpToLine(null);
      }, 100);
    }
  }, [selectedFile, jumpToLine, setJumpToLine]);

  const handleCompile = async () => {
    saveFile();
    setIsCompiling(true);
    setPdfErrorLog('');
    try {
      const res = await fetch('/api/latex/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: fileContent, filePath: selectedFile, projectPath: activeProject?.project_path })
      });
      const data = await res.json();
      if (data.success) {
        setPdfBase64(data.pdf_base64);
      } else {
        setPdfErrorLog(data.log);
        if (data.pdf_base64) setPdfBase64(data.pdf_base64);
      }
    } catch (err) {
      setPdfErrorLog('Failed to connect to backend: ' + err.message);
    } finally {
      setIsCompiling(false);
    }
  };

  const handlePrintPDF = () => {
    document.body.classList.add('printing-editor');
    window.print();
  };

  // Ref so the Monaco command closure always calls the latest callback,
  // even after React re-renders update isTerminalCollapsed state.
  const onToggleTerminalRef = useRef(onToggleTerminal);
  onToggleTerminalRef.current = onToggleTerminal;

  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;

  const localEditorRef = useRef(null);
  const pdfPreviewRef = useRef(null);
  
  const handleSyncTexNavigate = (line, file) => {
    if (file && file !== selectedFile) {
      handleFileSelect(file, line);
    } else if (localEditorRef.current) {
      localEditorRef.current.revealLineInCenter(line);
      localEditorRef.current.setPosition({ lineNumber: line, column: 1 });
      localEditorRef.current.focus();
    }
  };

  // Custom syntax definitions
  const handleBeforeMount = (monaco) => {
    const languages = monaco.languages.getLanguages();
    if (!languages.some(lang => lang.id === 'latex')) {
      monaco.languages.register({ id: 'latex' });
      monaco.languages.setMonarchTokensProvider('latex', {
        tokenizer: {
          root: [
            [/\\[a-zA-Z]+/, 'keyword'],
            [/%.*$/, 'comment'],
            [/[{}]/, 'delimiter.bracket'],
            [/\$/, 'string.quote'],
            [/[\[\]]/, 'delimiter.array'],
          ]
        }
      });
    }
  };

  // Wrap the external mount handler so we can also register the context-menu
  // actions and the Ctrl+L shortcut ourselves.
  const handleMount = (editor, monaco) => {
    const isDiff = typeof editor.getModifiedEditor === 'function';
    const actualEditor = isDiff ? editor.getModifiedEditor() : editor;

    localEditorRef.current = actualEditor;

    if (isDiff) {
      const originalDispose = editor.dispose;
      editor.dispose = function() {
        try { editor.setModel(null); } catch (e) {}
        originalDispose.apply(this, arguments);
      };

      actualEditor.onDidChangeModelContent(() => {
        setFileContent(actualEditor.getValue());
      });
    }

    // ── Forward Search (Ctrl+Click or Alt+Click on editor) ───────────────────────────────
    actualEditor.onMouseUp(async (e) => {
      // Check if Ctrl, Meta (Cmd on Mac), or Alt is pressed
      if (e.event.ctrlKey || e.event.metaKey || e.event.altKey) {
        const line = e.target.position?.lineNumber;
        const currentProject = activeProjectRef.current;
        const currentFile = selectedFileRef.current;
        
        if (line && currentProject?.project_path && currentFile) {
          console.log('Forward Search: editor line =', line, ', file =', currentFile);
          try {
            const res = await fetch(`/api/latex/synctex?action=tex2pdf&line=${line}&filePath=${encodeURIComponent(currentFile)}&projectPath=${encodeURIComponent(currentProject.project_path)}`);
            const data = await res.json();
            if (res.ok && data.result && data.result.page && pdfPreviewRef.current) {
              console.log('SyncTeX result:', JSON.stringify(data.result));
              pdfPreviewRef.current.scrollTo(data.result.page, data.result.x, data.result.y, data.result.w, data.result.h);
            } else {
              setPdfErrorLog(`SyncTeX Forward Search failed: ${data.error || 'No result found'}`);
            }
          } catch (err) {
            setPdfErrorLog("SyncTeX request failed: " + err.message);
          }
        }
      }
    });

    // ── Ctrl+J — toggle terminal ────────────────────────────────────────────
    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ,
      () => {
        if (onToggleTerminalRef.current) onToggleTerminalRef.current();
      }
    );

    // ── Ctrl+L — open inline free prompt ────────────────────────────────────
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL,
      () => {
        const model = actualEditor.getModel();
        const sel = actualEditor.getSelection();
        if (!model || !sel) return;

        const selectedText = model.getValueInRange(sel);
        const pos = actualEditor.getPosition();

        // Get pixel coordinates near the cursor
        const coords = actualEditor.getScrolledVisiblePosition(pos);
        const domNode = actualEditor.getDomNode();
        const rect = domNode?.getBoundingClientRect() ?? { left: 200, top: 100 };

        setInlinePrompt({
          x: rect.left + (coords?.left ?? 60) + 20,
          y: rect.top + (coords?.top ?? 40) + 24,
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
          cursorCol: pos?.column ?? 1,
          selectedText,
          mode: 'free',
        });
      }
    );

    // ── Paste via backend (navigator.clipboard.readText fails while context
    //    menu is open because hasTextFocus() is false; run() receives the
    //    editor directly so it works regardless of focus state).
    actualEditor.addAction({
      id: 'opalatex.paste',
      label: 'Paste',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 3,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV],
      run: async (ed) => {
        let text = '';
        try {
          const res = await fetch('/api/clipboard/read');
          const data = await res.json();
          text = data.text ?? '';
        } catch (_) {}
        if (text) ed.trigger('keyboard', 'paste', { text });
      },
    });

    // ── Monaco context menu — Refine Selection ───────────────────────────────
    actualEditor.addAction({
      id: 'opalatex.refineSelection',
      label: t('editorPanel.refineSelection'),
      contextMenuGroupId: 'opalatex',
      contextMenuOrder: 1,
      // Only show when there is a non-empty selection
      precondition: 'editorHasSelection',
      run: (ed) => {
        const model = ed.getModel();
        const sel = ed.getSelection();
        if (!model || !sel) return;
        const selectedText = model.getValueInRange(sel);
        const pos = ed.getPosition();
        const coords = ed.getScrolledVisiblePosition(pos);
        const domNode = ed.getDomNode();
        const rect = domNode?.getBoundingClientRect() ?? { left: 200, top: 100 };
        setInlinePrompt({
          x: rect.left + (coords?.left ?? 60) + 20,
          y: rect.top + (coords?.top ?? 40) + 24,
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
          cursorCol: pos?.column ?? 1,
          selectedText,
          mode: 'refine',
        });
      },
    });

    // ── Monaco context menu — Generate Code ──────────────────────────────────
    actualEditor.addAction({
      id: 'opalatex.generateCode',
      label: t('editorPanel.generateCode'),
      contextMenuGroupId: 'opalatex',
      contextMenuOrder: 2,
      run: (ed) => {
        const model = ed.getModel();
        const pos = ed.getPosition();
        if (!model || !pos) return;
        
        const sel = ed.getSelection();
        const selectedText = (sel && !sel.isEmpty()) ? model.getValueInRange(sel) : '';

        const coords = ed.getScrolledVisiblePosition(pos);
        const domNode = ed.getDomNode();
        const rect = domNode?.getBoundingClientRect() ?? { left: 200, top: 100 };
        setInlinePrompt({
          x: rect.left + (coords?.left ?? 60) + 20,
          y: rect.top + (coords?.top ?? 40) + 24,
          startLine: pos.lineNumber,
          endLine: pos.lineNumber,
          cursorCol: pos.column,
          selectedText,
          mode: 'generate',
        });
      },
    });

    // Delegate to the parent-level mount handler (font-size, Ctrl+S, etc.)
    if (handleEditorDidMount) handleEditorDidMount(actualEditor, monaco);
    
    // Focus the editor when it is first mounted
    setTimeout(() => actualEditor.focus(), 50);
  };

  useEffect(() => {
    if (localEditorRef.current && selectedFile) {
      setTimeout(() => localEditorRef.current?.focus(), 50);
    }
  }, [selectedFile]);

  if (!selectedFile) {
    return (
      <div className="vscode-editor-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <Files size={64} style={{ color: '#3c3c3c', marginBottom: '16px' }} />
          <h3 style={{ fontSize: '14px', fontWeight: 'bold', color: '#b0b0b0', marginBottom: '4px' }}>{t('editorPanel.noFileOpen')}</h3>
          <p style={{ fontSize: '12px', color: '#808080' }}>{t('editorPanel.openFileHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="vscode-editor-panel" style={{ position: 'relative' }}>
      {/* Tab bar */}
      <div className="vscode-tabs">
        <div className="flex h-full overflow-x-auto" style={{ gap: '2px' }}>
          {openFiles.map(filePath => {
            const isActive = filePath === selectedFile;
            const currentContent = isActive ? fileContent : fileContents[filePath];
            const isDirty = originalFileContents && currentContent !== originalFileContents[filePath] && originalFileContents[filePath] !== undefined;

            return (
              <div
                key={filePath}
                onClick={() => handleFileSelect(filePath)}
                className={`vscode-tab ${isActive ? 'active' : ''}`}
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                <span style={{ color: isActive ? '#ffffff' : '#a0a0a0' }}>
                  {filePath.replace(/\\/g, '/').split('/').pop()}{isDirty ? ' *' : ''}
                </span>
                <button
                  onClick={(e) => handleCloseTab(filePath, e)}
                  className="vscode-tab-close-btn"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isTexFile && (
            <button
              onClick={handleCompile}
              disabled={isCompiling || isSaving || !isTectonicAvailable}
              className="vscode-button"
              style={{ backgroundColor: isTectonicAvailable ? '#217b3b' : '#3c3c3c', color: isTectonicAvailable ? 'white' : '#888', cursor: isTectonicAvailable ? 'pointer' : 'not-allowed' }}
              title={!isTectonicAvailable ? 'Falta compilador! Instale em Settings.' : ''}
            >
              {(isCompiling || isSaving) ? <RefreshCw size={12} className="animate-spin" /> : <Printer size={12} />}
              <span>{isCompiling ? 'Compiling...' : (isSaving ? t('editorPanel.saving') : 'Compile LaTeX')}</span>
            </button>
          )}
          <button
            onClick={saveFile}
            disabled={isSaving}
            className="vscode-button"
          >
            {isSaving ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
            <span>{isSaving ? t('editorPanel.saving') : t('editorPanel.save')}</span>
          </button>

          <button
            onClick={() => setIsDiffMode(!isDiffMode)}
            className="vscode-bottom-panel-clear-btn"
            style={{ padding: '6px' }}
            title={isDiffMode ? t('editorPanel.disableDiff') : t('editorPanel.enableDiff')}
          >
            <GitCompare size={12} style={{ color: isDiffMode ? '#4daafc' : 'inherit' }} />
          </button>

          {selectedFile && selectedFile.toLowerCase().endsWith('.md') && (
            <>
              {isPreviewMode && (
                <button
                  onClick={handlePrintPDF}
                  className="vscode-bottom-panel-clear-btn"
                  style={{ padding: '6px' }}
                  title="Imprimir / Exportar PDF"
                >
                  <Printer size={12} />
                </button>
              )}
              <button
                onClick={() => setIsPreviewMode(!isPreviewMode)}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={isPreviewMode ? "Editar Markdown" : "Visualizar Renderizado"}
              >
                {isPreviewMode ? <EyeOff size={12} style={{ color: '#4daafc' }} /> : <Eye size={12} />}
              </button>
            </>
          )}

          <button
            onClick={onToggleMaximize}
            className="vscode-bottom-panel-clear-btn"
            style={{ padding: '6px' }}
            title={isMaximized ? t('editorPanel.restoreEditor') : t('editorPanel.maximizeEditor')}
          >
            {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>

      {/* Monaco editor and PDF Preview Split */}
      <div style={{ flex: 1, minHeight: 0, height: 'calc(100% - 35px)' }}>
        {isPdfFile ? (
          <div style={{ height: '100%', background: '#0A0D14' }}>
            <PdfPreview 
              ref={pdfPreviewRef}
              directUrl={`/api/file/raw?projectPath=${encodeURIComponent(activeProject?.project_path)}&filePath=${encodeURIComponent(selectedFile)}`}
              base64Pdf={null}
              isCompiling={false}
              errorLog={''}
              activeProject={activeProject}
              selectedFile={selectedFile}
              onSyncTexNavigate={handleSyncTexNavigate}
            />
          </div>
        ) : isTexFile ? (
          <Split
            sizes={[50, 50]}
            minSize={200}
            expandToMin={false}
            gutterSize={4}
            gutterAlign="center"
            snapOffset={30}
            dragInterval={1}
            direction="horizontal"
            cursor="col-resize"
            style={{ display: 'flex', height: '100%', width: '100%' }}
        >
          <div className="vscode-editor-container" style={{ position: 'relative', height: '100%' }}>
            {isPreviewMode ? (
              <div style={{ padding: '20px', overflowY: 'auto', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, boxSizing: 'border-box' }} className="markdown-preview-container">
                {formatMessageContent(fileContent, activeProject?.project_path)}
              </div>
            ) : isDiffMode ? (
              <DiffEditor
                height="100%"
                language={getLanguage(selectedFile)}
                theme={theme === 'light' ? 'light' : 'vs-dark'}
                original={originalFileContents ? (originalFileContents[selectedFile] || '') : ''}
                modified={fileContent}
                originalModelPath={`original-${selectedFile}`}
                modifiedModelPath={`modified-${selectedFile}`}
                beforeMount={handleBeforeMount}
                onMount={handleMount}
                options={{
                  minimap: { enabled: true },
                  fontSize: editorFontSize,
                  lineNumbers: 'on',
                  tabSize: editorTabSize,
                  wordWrap: editorWordWrap,
                  automaticLayout: true,
                  renderSideBySide: true,
                  readOnly: false,
                  originalEditable: false,
                }}
              />
            ) : (
              <Editor
                height="100%"
                path={selectedFile}
                language={getLanguage(selectedFile)}
                theme={theme === 'light' ? 'light' : 'vs-dark'}
                value={fileContent}
                beforeMount={handleBeforeMount}
                onChange={(val) => setFileContent(val)}
                onMount={handleMount}
                options={{
                  minimap: { enabled: true },
                  fontSize: editorFontSize,
                  lineNumbers: 'on',
                  tabSize: editorTabSize,
                  wordWrap: editorWordWrap,
                  automaticLayout: true,
                }}
              />
            )}
          </div>
          <div style={{ height: '100%', background: '#0A0D14', borderLeft: '1px solid #1E2330' }}>
            <PdfPreview 
              ref={pdfPreviewRef}
              base64Pdf={pdfBase64} 
              isCompiling={isCompiling} 
              errorLog={pdfErrorLog} 
              activeProject={activeProject}
              selectedFile={selectedFile}
              onSyncTexNavigate={handleSyncTexNavigate}
            />
          </div>
          </Split>
        ) : (
          <div className="vscode-editor-container" style={{ position: 'relative', height: '100%' }}>
            {isPreviewMode ? (
              <div style={{ padding: '20px', overflowY: 'auto', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, boxSizing: 'border-box' }} className="markdown-preview-container">
                {formatMessageContent(fileContent, activeProject?.project_path)}
              </div>
            ) : isDiffMode ? (
              <DiffEditor
                height="100%"
                language={getLanguage(selectedFile)}
                theme={theme === 'light' ? 'light' : 'vs-dark'}
                original={originalFileContents ? (originalFileContents[selectedFile] || '') : ''}
                modified={fileContent}
                originalModelPath={`original-${selectedFile}`}
                modifiedModelPath={`modified-${selectedFile}`}
                beforeMount={handleBeforeMount}
                onMount={handleMount}
                options={{
                  minimap: { enabled: true },
                  fontSize: editorFontSize,
                  lineNumbers: 'on',
                  tabSize: editorTabSize,
                  wordWrap: editorWordWrap,
                  automaticLayout: true,
                  renderSideBySide: true,
                  readOnly: false,
                  originalEditable: false,
                }}
              />
            ) : (
              <Editor
                height="100%"
                path={selectedFile}
                language={getLanguage(selectedFile)}
                theme={theme === 'light' ? 'light' : 'vs-dark'}
                value={fileContent}
                beforeMount={handleBeforeMount}
                onChange={(val) => setFileContent(val)}
                onMount={handleMount}
                options={{
                  minimap: { enabled: true },
                  fontSize: editorFontSize,
                  lineNumbers: 'on',
                  tabSize: editorTabSize,
                  wordWrap: editorWordWrap,
                  automaticLayout: true,
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Inline prompt overlay (rendered inside the panel for correct stacking) */}
      {inlinePrompt && (
        <InlinePromptOverlay
          inlinePrompt={inlinePrompt}
          onSubmit={onInlineSubmit}
          onClose={() => setInlinePrompt(null)}
          onCancel={onInlineCancel}
          isRunning={isInlineRunning}
        />
      )}
    </div>
  );
}
