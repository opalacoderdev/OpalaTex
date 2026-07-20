import { Suspense, lazy, useRef, useEffect, useState, useCallback } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { Files, RefreshCw, Save, X, Maximize2, Minimize2, GitCompare, Eye, EyeOff, Printer, Download, ZoomIn, ZoomOut, PlusSquare, Type, PanelRightOpen, Trash2, FileText, HelpCircle, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getLanguage } from '../utils/language';
import { safeSetLocalStorage } from '../utils/storage';
import InlinePromptOverlay from './InlinePromptOverlay';
import EditorContextMenuOverlay from './EditorContextMenuOverlay';
import { formatMessageContent } from '../utils/formatMessage';
import Split from 'react-split';
import PdfPreview from './PdfPreview';
import LatexPreview from './LatexPreview';
import LatexSnippetsPanel from './LatexSnippetsPanel';
import RichTextEditor from './RichTextEditor';

const DocxEditorPanel = lazy(() => import('./DocxEditorPanel'));
const PptxEditorPanel = lazy(() => import('./PptxEditorPanel'));

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
  setEditorFontSize,
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
  triggerCompileRequest,
  onBinaryFileSaved,
  onRegisterBinarySave,
}) {
  const { t } = useTranslation();
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [isLatexPreviewMode, setIsLatexPreviewMode] = useState(false);
  const [isRichTextMode, setIsRichTextMode] = useState(false);
  const [isPdfPreviewCollapsed, setIsPdfPreviewCollapsed] = useState(false);
  const [showSnippetsPanel, setShowSnippetsPanel] = useState(false);
  const [showLatexHelp, setShowLatexHelp] = useState(false);
  const [showDocumentActionsMenu, setShowDocumentActionsMenu] = useState(false);
  const [editorContextMenu, setEditorContextMenu] = useState(null);
  const [markdownZoomLevel, setMarkdownZoomLevel] = useState(1.0);
  const pendingEditorLineRef = useRef(null);
  const richTextSourceLineRef = useRef(1);
  const documentActionsMenuRef = useRef(null);
  const docxEditorRef = useRef(null);
  const pptxEditorRef = useRef(null);
  
  const isPdfFile = selectedFile && selectedFile.toLowerCase().endsWith('.pdf');
  const isDocxFile = selectedFile && selectedFile.toLowerCase().endsWith('.docx');
  const isPptxFile = selectedFile && selectedFile.toLowerCase().endsWith('.pptx');
  const isTexRelatedFile = (filename) => {
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return ['tex', 'cls', 'sty', 'bib'].includes(ext);
  };
  const isTexFile = isTexRelatedFile(selectedFile);
  const isNormalLatexEditor = isTexFile && !isRichTextMode && !isLatexPreviewMode && !isPreviewMode;

  const saveBinaryEditor = useCallback(() => {
    if (isDocxFile) return docxEditorRef.current?.save?.() || false;
    if (isPptxFile) return pptxEditorRef.current?.save?.() || false;
    return false;
  }, [isDocxFile, isPptxFile]);

  useEffect(() => {
    if (isDocxFile || isPptxFile) {
      onRegisterBinarySave?.(saveBinaryEditor);
      return () => onRegisterBinarySave?.(null);
    }
    onRegisterBinarySave?.(null);
    return undefined;
  }, [isDocxFile, isPptxFile, onRegisterBinarySave, saveBinaryEditor, selectedFile]);

  const updateEditorFontSize = useCallback((updater) => {
    if (!setEditorFontSize) return;
    setEditorFontSize(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      safeSetLocalStorage('editorFontSize', next);
      return next;
    });
  }, [setEditorFontSize]);

  // PDF state
  const [pdfUrl, setPdfUrl] = useState(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [pdfErrorLog, setPdfErrorLog] = useState('');
  const [compileTiming, setCompileTiming] = useState(null);
  const [cleanMessage, setCleanMessage] = useState('');
  const [isTectonicAvailable, setIsTectonicAvailable] = useState(true);
  const [isPandocAvailable, setIsPandocAvailable] = useState(true);
  const [isInstallingTectonic, setIsInstallingTectonic] = useState(false);
  const [isInstallingPandoc, setIsInstallingPandoc] = useState(false);
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [isCleaningLatex, setIsCleaningLatex] = useState(false);
  const pendingPdfSyncRef = useRef(null);

  const getCurrentEditorLine = () => (
    localEditorRef.current?.getPosition?.()?.lineNumber || null
  );

  const syncPdfToEditorLine = useCallback(async ({ line, filePath, projectPath }) => {
    if (!line || !filePath || !projectPath) return false;
    try {
      const res = await fetch(`/api/latex/synctex?action=tex2pdf&line=${line}&filePath=${encodeURIComponent(filePath)}&projectPath=${encodeURIComponent(projectPath)}`);
      const data = await res.json();
      if (res.ok && data.result?.page && pdfPreviewRef.current) {
        pdfPreviewRef.current.scrollTo(data.result.page, data.result.x, data.result.y, data.result.w, data.result.h);
        return true;
      }
      if (!res.ok || data.error) {
        setPdfErrorLog(`SyncTeX Forward Search failed: ${data.error || 'No result found'}`);
      }
    } catch (err) {
      setPdfErrorLog("SyncTeX request failed: " + err.message);
    }
    return false;
  }, []);

  const handlePdfDocumentReady = useCallback(() => {
    const pending = pendingPdfSyncRef.current;
    if (!pending) return;
    pendingPdfSyncRef.current = null;
    syncPdfToEditorLine(pending);
  }, [syncPdfToEditorLine]);

  const handleInstallTectonic = async () => {
    setIsInstallingTectonic(true);
    try {
      const res = await fetch('/api/settings/install-tectonic', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setIsTectonicAvailable(true);
      } else {
        alert(t('editorPanel.installTectonicError') + (data.error || ''));
      }
    } catch (err) {
      alert(t('editorPanel.installTectonicError') + err);
    } finally {
      setIsInstallingTectonic(false);
    }
  };

  const checkTectonic = () => {
    fetch('/api/latex/check-tectonic')
      .then(r => r.json())
      .then(data => setIsTectonicAvailable(data.found))
      .catch(() => {});
  };

  const checkPandoc = () => {
    fetch('/api/latex/check-pandoc')
      .then(r => r.json())
      .then(data => setIsPandocAvailable(data.found))
      .catch(() => {});
  };

  useEffect(() => {
    checkTectonic();
    checkPandoc();
    const checkDocumentTools = () => {
      checkTectonic();
      checkPandoc();
    };
    window.addEventListener('focus', checkDocumentTools);
    return () => window.removeEventListener('focus', checkDocumentTools);
  }, []);

  // Clear PDF only when switching projects
  const prevProjectRef = useRef(activeProject?.project_path);
  useEffect(() => {
    if (activeProject?.project_path !== prevProjectRef.current) {
      setPdfUrl(null);
      setPdfErrorLog('');
      prevProjectRef.current = activeProject?.project_path;
    }
  }, [activeProject?.project_path]);

  // ── Restore or compile ──────────────────────────────────────────────────
  useEffect(() => {
    setIsDiffMode(false);
    setIsPreviewMode(false);
    setIsLatexPreviewMode(false);
    setIsRichTextMode(false);
    setShowSnippetsPanel(false);
    
    // Check if there is an existing PDF for this file
    if (selectedFile && selectedFile.toLowerCase().endsWith('.tex') && activeProject?.project_path) {
      fetch(`/api/latex/check-pdf?filePath=${encodeURIComponent(selectedFile)}&projectPath=${encodeURIComponent(activeProject.project_path)}`)
        .then(r => r.json())
        .then(data => {
          if (data.found && (data.pdf_url || data.pdf_base64)) {
            setPdfUrl(data.pdf_url || `/api/latex/pdf?ts=${Date.now()}`);
            setPdfErrorLog('');
          }
          // If not found, do NOT clear pdfUrl, so the main document's PDF remains visible
          // when clicking into an included file (e.g., apendice.tex).
        })
        .catch(() => {});
    }
    // We also do NOT clear pdfUrl if not a .tex file,
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

  const handleCompile = async (skipSave = false, partial = false) => {
    if (!skipSave) {
      const saved = await saveFile({ suppressCompile: true });
      if (!saved) return;
    }
    const compileLine = getCurrentEditorLine();
    const compileFile = selectedFile;
    const compileProjectPath = activeProject?.project_path;
    setIsCompiling(true);
    setPdfErrorLog('');
    setCleanMessage('');
    setCompileTiming(null);
    try {
      const res = await fetch('/api/latex/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: fileContent,
          filePath: selectedFile,
          projectPath: activeProject?.project_path,
          projectName: activeProject?.name || '',
          mainFile: activeProject?.main_file || '',
          partial,
        })
      });
      const data = await res.json();
      if (data.timing) setCompileTiming(data.timing);
      if (data.success) {
        if (compileLine && compileFile && compileProjectPath) {
          pendingPdfSyncRef.current = {
            line: compileLine,
            filePath: compileFile,
            projectPath: compileProjectPath,
          };
        }
        setPdfUrl(data.pdf_url || `/api/latex/pdf?ts=${Date.now()}`);
      } else {
        setPdfErrorLog(data.log);
        if (data.pdf_url || data.pdf_base64) setPdfUrl(data.pdf_url || `/api/latex/pdf?ts=${Date.now()}`);
        else setPdfUrl(null);
      }
    } catch (err) {
      setPdfErrorLog('Failed to connect to backend: ' + err.message);
      setPdfUrl(null);
    } finally {
      setIsCompiling(false);
    }
  };

  const handleCleanLatex = async () => {
    if (!activeProject?.project_path) return;
    setIsCleaningLatex(true);
    setPdfErrorLog('');
    setCompileTiming(null);
    setCleanMessage('');
    try {
      const res = await fetch('/api/latex/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path })
      });
      const data = await res.json();
      if (data.success) {
        setPdfUrl(null);
        setCleanMessage(`Cleaned ${data.removed?.length || 0}`);
      } else {
        setPdfErrorLog((data.errors || ['Clean failed']).join('\n'));
      }
    } catch (err) {
      setPdfErrorLog('Failed to clean LaTeX artifacts: ' + err.message);
    } finally {
      setIsCleaningLatex(false);
    }
  };

  const handleInstallPandoc = async () => {
    setIsInstallingPandoc(true);
    try {
      const res = await fetch('/api/settings/install-pandoc', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setIsPandocAvailable(true);
      } else {
        alert(t('editorPanel.installPandocError') + (data.error || ''));
      }
    } catch (err) {
      alert(t('editorPanel.installPandocError') + err);
    } finally {
      setIsInstallingPandoc(false);
    }
  };

  const handleExportDocx = async () => {
    const saved = await saveFile({ suppressCompile: true });
    if (!saved) return;
    setIsExportingDocx(true);
    setPdfErrorLog('');
    setCleanMessage('');
    try {
      const res = await fetch('/api/latex/export-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: fileContent,
          filePath: selectedFile,
          projectPath: activeProject?.project_path,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setCleanMessage(`DOCX: ${data.relative_output_path || data.output_path}`);
      } else {
        if (data.pandoc_found === false) setIsPandocAvailable(false);
        setPdfErrorLog(data.log || data.error || 'DOCX export failed.');
      }
    } catch (err) {
      setPdfErrorLog('Failed to export DOCX: ' + err.message);
    } finally {
      setIsExportingDocx(false);
    }
  };

  const formatCompileTiming = (timing) => {
    if (!timing) return '';
    const seconds = timing.compile_seconds ?? timing.request_seconds;
    if (typeof seconds !== 'number') return '';
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  };

  useEffect(() => {
    if (triggerCompileRequest?.id) {
      handleCompile(true, triggerCompileRequest.partial === true);
    }
  }, [triggerCompileRequest]);

  useEffect(() => {
    if (!showDocumentActionsMenu) return;
    const handlePointerDown = (event) => {
      if (!documentActionsMenuRef.current?.contains(event.target)) {
        setShowDocumentActionsMenu(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showDocumentActionsMenu]);

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
  const monacoRef = useRef(null);
  const editorContainerRef = useRef(null);
  const pdfPreviewRef = useRef(null);

  const revealEditorLine = useCallback((line) => {
    if (!line || !localEditorRef.current) return false;
    localEditorRef.current.revealLineInCenter(line);
    localEditorRef.current.setPosition({ lineNumber: line, column: 1 });
    localEditorRef.current.focus();
    return true;
  }, []);

  const exitRichTextMode = useCallback((line = richTextSourceLineRef.current) => {
    if (line) pendingEditorLineRef.current = line;
    setIsRichTextMode(false);
  }, []);
  
  const handleSyncTexNavigate = (line, file) => {
    // file is a project-relative path returned from the SyncTeX backend
    const normalizeSlash = (p) => (p || '').replace(/\\/g, '/');
    const normalizedFile = normalizeSlash(file);
    const normalizedSelected = normalizeSlash(selectedFile);

    // Guard against empty/invalid file paths from SyncTeX — these would
    // open a blank untitled tab in the editor.
    if (!file || !file.trim()) {
      if (isRichTextMode) {
        exitRichTextMode(line);
      } else if (localEditorRef.current) {
        localEditorRef.current.revealLineInCenter(line);
        localEditorRef.current.setPosition({ lineNumber: line, column: 1 });
        localEditorRef.current.focus();
      }
      return;
    }

    if (normalizedFile !== normalizedSelected) {
      // Switching to a different file — handleFileSelect sets jumpToLine so
      // the editor navigates after the file loads. Exit Rich Text mode
      // first so Monaco mounts and can consume the jump target.
      if (isRichTextMode) exitRichTextMode(line);
      handleFileSelect(file, line);
    } else if (isRichTextMode) {
      // Same file, but Monaco is not mounted in Rich Text mode — exit to
      // Monaco and let the mount handler reveal the target line.
      exitRichTextMode(line);
    } else if (localEditorRef.current) {
      localEditorRef.current.revealLineInCenter(line);
      localEditorRef.current.setPosition({ lineNumber: line, column: 1 });
      localEditorRef.current.focus();
    }
  };

  // ── Insert LaTeX snippet at the current cursor position ──────────────────
  const handleInsertSnippet = (snippetBody) => {
    // In Rich Text mode, Monaco is not mounted — append to fileContent
    if (isRichTextMode) {
      setFileContent(fileContent + '\n' + snippetBody + '\n');
      setShowSnippetsPanel(false);
      return;
    }
    const ed = localEditorRef.current;
    if (!ed) {
      // Fallback: append to content
      setFileContent(fileContent + '\n' + snippetBody + '\n');
      setShowSnippetsPanel(false);
      return;
    }
    const position = ed.getPosition();
    const model = ed.getModel();
    if (!model || !position) return;
    // Insert with surrounding newlines for block snippets
    const lineContent = model.getLineContent(position.lineNumber);
    const isBlock = snippetBody.includes('\n');
    let text = snippetBody;
    if (isBlock && lineContent.trim() !== '') {
      text = '\n' + text;
    }
    ed.executeEdits('opalatex-snippet', [{
      range: {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      },
      text,
      forceMoveMarkers: true,
    }]);
    ed.focus();
    setShowSnippetsPanel(false);
  };

  // ── Jump from Rich Text block to source line in Monaco ──────────────────
  const handleRichTextJumpToSource = (line, _charOffset) => {
    // Exit rich text mode and show the Monaco editor at the target line
    exitRichTextMode(line);
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
    monacoRef.current = monaco;

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
          syncPdfToEditorLine({
            line,
            filePath: currentFile,
            projectPath: currentProject.project_path,
          });
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
          startColumn: sel.startColumn,
          endColumn: sel.endColumn,
          cursorCol: pos?.column ?? 1,
          selectedText,
          mode: 'free',
        });
      }
    );

    // ── Ctrl++ / Ctrl+- — Markdown preview zoom ───────────────────────────
    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal,
      () => {
        if (isPreviewMode) {
          setMarkdownZoomLevel(prev => Math.min(2.0, prev + 0.1));
        }
      }
    );
    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus,
      () => {
        if (isPreviewMode) {
          setMarkdownZoomLevel(prev => Math.max(0.5, prev - 0.1));
        }
      }
    );
    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyNumpad0,
      () => {
        if (isPreviewMode) {
          setMarkdownZoomLevel(1.0);
        }
      }
    );

    // ── Paste via Ctrl+V keybinding (navigator.clipboard.readText may fail
    //    while context menu is open; using backend clipboard read instead).
    actualEditor.addAction({
      id: 'opalatex.paste',
      label: 'Paste',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV],
      precondition: 'editorTextFocus',
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

    // Delegate to the parent-level mount handler (font-size, Ctrl+S, etc.)
    if (handleEditorDidMount) handleEditorDidMount(actualEditor, monaco);
    
    // Focus the editor when it is first mounted
    setTimeout(() => {
      const pendingLine = pendingEditorLineRef.current;
      if (pendingLine && revealEditorLine(pendingLine)) {
        pendingEditorLineRef.current = null;
      } else {
        actualEditor.focus();
      }
    }, 50);
  };

  // ── Custom context menu listener on the editor container ────────────────
  // Attached to the stable container div via ref, reads the current editor
  // from localEditorRef so it survives file switches and editor remounts.
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

      const model = ed.getModel();
      const sel = ed.getSelection();
      const pos = ed.getPosition();
      const hasSelection = sel && !sel.isEmpty();
      const selectedText = hasSelection ? model?.getValueInRange(sel) : '';

      setEditorContextMenu({
        x: e.clientX,
        y: e.clientY,
        editor: ed,
        monaco,
        hasSelection,
        selectedText,
        pos,
        sel,
      });
    };

    container.addEventListener('contextmenu', handleContextMenu, true);
    return () => container.removeEventListener('contextmenu', handleContextMenu, true);
  }, [selectedFile]);

  useEffect(() => {
    if (localEditorRef.current && selectedFile) {
      setTimeout(() => localEditorRef.current?.focus(), 50);
    }
  }, [selectedFile]);

  useEffect(() => {
    setShowLatexHelp(false);
  }, [selectedFile]);

  if (!selectedFile) {
    return (
      <div className="vscode-editor-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <Files size={64} style={{ color: 'var(--vscode-border)', marginBottom: '16px' }} />
          <h3 style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--vscode-text-fg)', marginBottom: '4px' }}>{t('editorPanel.noFileOpen')}</h3>
          <p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>{t('editorPanel.openFileHint')}</p>
        </div>
      </div>
    );
  }

  const renderTexEditorSurface = () => (
    <div className="vscode-editor-container" style={{ position: 'relative', height: '100%' }}>
      {isRichTextMode ? (
        <RichTextEditor
          source={fileContent}
          activeProjectPath={activeProject?.project_path}
          sourceTex={selectedFile}
          zoomLevel={markdownZoomLevel}
          initialSourceLine={richTextSourceLineRef.current}
          onChange={setFileContent}
          onJumpToSource={handleRichTextJumpToSource}
          onActiveSourceLineChange={(line) => {
            if (line) richTextSourceLineRef.current = line;
          }}
        />
      ) : isLatexPreviewMode ? (
        <LatexPreview
          source={fileContent}
          activeProjectPath={activeProject?.project_path}
          zoomLevel={markdownZoomLevel}
        />
      ) : isPreviewMode ? (
        <div style={{ padding: '20px', overflowY: 'auto', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, boxSizing: 'border-box' }} className="markdown-preview-container">
          {formatMessageContent(fileContent, activeProject?.project_path, markdownZoomLevel)}
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
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          beforeMount={handleBeforeMount}
          onMount={handleMount}
          options={{
            contextmenu: false,
            minimap: { enabled: true },
            fontSize: editorFontSize,
            lineNumbers: 'on',
            tabSize: editorTabSize,
            wordWrap: editorWordWrap,
            automaticLayout: true,
            renderSideBySide: true,
            readOnly: false,
            originalEditable: false,
            fixedOverflowWidgets: true,
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
            contextmenu: false,
            minimap: { enabled: true },
            fontSize: editorFontSize,
            lineNumbers: 'on',
            tabSize: editorTabSize,
            wordWrap: editorWordWrap,
            automaticLayout: true,
            fixedOverflowWidgets: true,
          }}
        />
      )}
      {showSnippetsPanel && (
        <LatexSnippetsPanel
          onInsert={handleInsertSnippet}
          onClose={() => setShowSnippetsPanel(false)}
        />
      )}
    </div>
  );

  return (
    <div ref={editorContainerRef} className="vscode-editor-panel" style={{ position: 'relative' }}>
      {/* Tab bar */}
      <div className="vscode-tabs">
        <div className="vscode-tab-list">
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
                <span
                  className="vscode-tab-label"
                  title={filePath}
                  style={{ color: isActive ? '#ffffff' : '#a0a0a0' }}
                >
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

        <div className="vscode-editor-actions">
          {isTexFile && isTectonicAvailable && (
            <button
              onClick={() => handleCompile(false, false)}
              disabled={isCompiling || isSaving}
              className="vscode-editor-action-btn vscode-editor-action-btn-primary"
              title={isCompiling
                ? t('editorPanel.compiling')
                : compileTiming
                  ? t('editorPanel.compileTooltipWithTiming', { timing: formatCompileTiming(compileTiming) })
                  : t('editorPanel.compileTooltip')}
              aria-label={isCompiling ? t('editorPanel.compiling') : t('editorPanel.compile')}
            >
              {(isCompiling || isSaving) ? <RefreshCw size={14} className="animate-spin" /> : <Printer size={14} />}
            </button>
          )}
          {isTexFile && isTectonicAvailable && (
            <button
              onClick={() => handleCompile(false, true)}
              disabled={isCompiling || isSaving}
              className="vscode-editor-action-btn"
              title={t('editorPanel.compilePartialTooltip')}
              aria-label={t('editorPanel.compilePartial')}
            >
              {(isCompiling || isSaving) ? <RefreshCw size={14} className="animate-spin" /> : <FileText size={14} />}
            </button>
          )}
          {isTexFile && (
            <div ref={documentActionsMenuRef} className="vscode-overflow-menu-wrap">
              <button
                onClick={() => setShowDocumentActionsMenu(prev => !prev)}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={t('editorPanel.documentActions', 'Document actions')}
                aria-label={t('editorPanel.documentActions', 'Document actions')}
                aria-expanded={showDocumentActionsMenu}
              >
                <MoreHorizontal size={12} />
              </button>
              {showDocumentActionsMenu && (
                <div className="vscode-overflow-menu" role="menu">
                  {isTectonicAvailable && (
                    <button
                      type="button"
                      onClick={() => {
                        handleCleanLatex();
                        setShowDocumentActionsMenu(false);
                      }}
                      disabled={isCompiling || isSaving || isCleaningLatex}
                      className="vscode-overflow-menu-item"
                      role="menuitem"
                    >
                      {isCleaningLatex ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      <span>{t('editorPanel.cleanLatexArtifacts', 'Clean LaTeX artifacts')}</span>
                    </button>
                  )}
                  {isPandocAvailable ? (
                    <button
                      type="button"
                      onClick={() => {
                        handleExportDocx();
                        setShowDocumentActionsMenu(false);
                      }}
                      disabled={isExportingDocx || isSaving}
                      className="vscode-overflow-menu-item"
                      role="menuitem"
                    >
                      {isExportingDocx ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                      <span>{isExportingDocx ? t('editorPanel.exportingDocx') : t('editorPanel.exportDocx')}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        handleInstallPandoc();
                        setShowDocumentActionsMenu(false);
                      }}
                      disabled={isInstallingPandoc}
                      className="vscode-overflow-menu-item"
                      role="menuitem"
                    >
                      {isInstallingPandoc ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                      <span>{isInstallingPandoc ? t('editorPanel.installingPandoc') : t('editorPanel.installPandoc')}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {isTexFile && cleanMessage && !isCleaningLatex && !isCompiling && (
            <span
              style={{
                color: 'var(--vscode-descriptionForeground, #888)',
                fontSize: '11px',
                whiteSpace: 'nowrap',
              }}
            >
              {cleanMessage}
            </span>
          )}
          {isTexFile && !isTectonicAvailable && (
            <button
              onClick={handleInstallTectonic}
              disabled={isInstallingTectonic}
              className="vscode-editor-action-btn"
              title={t('editorPanel.installTectonicTooltip')}
              aria-label={isInstallingTectonic ? t('editorPanel.installingTectonic') : t('editorPanel.installTectonic')}
            >
              {isInstallingTectonic ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
            </button>
          )}
          {!isPptxFile && (
            <button
              onClick={saveFile}
              disabled={isSaving}
              className="vscode-editor-action-btn"
              title={t('editorPanel.save')}
              aria-label={t('editorPanel.save')}
            >
              {isSaving ? <Save size={12} className="save-pulse" /> : <Save size={12} />}
            </button>
          )}

          <button
            onClick={() => setIsDiffMode(!isDiffMode)}
            className="vscode-bottom-panel-clear-btn"
            style={{ padding: '6px' }}
            title={isDiffMode ? t('editorPanel.disableDiff') : t('editorPanel.enableDiff')}
          >
            <GitCompare size={12} style={{ color: isDiffMode ? '#4daafc' : 'inherit' }} />
          </button>

          {isTexFile && (
            <>
              {isPdfPreviewCollapsed && (
                <button
                  onClick={() => setIsPdfPreviewCollapsed(false)}
                  className="vscode-bottom-panel-clear-btn"
                  style={{ padding: '6px' }}
                  title={t('editorPanel.showPdfPreview')}
                >
                  <PanelRightOpen size={12} />
                </button>
              )}
              {isNormalLatexEditor && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                  <button
                    onClick={() => updateEditorFontSize(prev => Math.max(10, prev - 1))}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title={t('editorPanel.zoomOut')}
                  >
                    <ZoomOut size={12} />
                  </button>
                  <button
                    onClick={() => updateEditorFontSize(13)}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '4px 6px', minWidth: '38px', fontSize: '11px', color: 'var(--vscode-text-fg)' }}
                    title={t('editorPanel.resetZoom')}
                  >
                    {editorFontSize}px
                  </button>
                  <button
                    onClick={() => updateEditorFontSize(prev => Math.min(30, prev + 1))}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title={t('editorPanel.zoomIn')}
                  >
                    <ZoomIn size={12} />
                  </button>
                </div>
              )}
              <button
                onClick={() => {
                  if (isRichTextMode) {
                    exitRichTextMode();
                  } else {
                    const currentLine = localEditorRef.current?.getPosition?.()?.lineNumber;
                    if (currentLine) richTextSourceLineRef.current = currentLine;
                    setIsRichTextMode(true);
                  }
                  setIsLatexPreviewMode(false);
                  setIsPreviewMode(false);
                  setIsDiffMode(false);
                }}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={isRichTextMode ? 'Exit Rich Text mode' : 'Rich Text mode (Overleaf-style: edit prose, complex blocks read-only)'}
              >
                <Type size={12} style={{ color: isRichTextMode ? '#4daafc' : 'inherit' }} />
              </button>
              {isRichTextMode && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                  <button
                    onClick={() => setMarkdownZoomLevel(prev => Math.max(0.5, prev - 0.1))}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title={t('editorPanel.zoomOut')}
                  >
                    <ZoomOut size={12} />
                  </button>
                  <button
                    onClick={() => setMarkdownZoomLevel(1.0)}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '4px 6px', minWidth: '38px', fontSize: '11px', color: 'var(--vscode-text-fg)' }}
                    title={t('editorPanel.resetZoom')}
                  >
                    {Math.round(markdownZoomLevel * 100)}%
                  </button>
                  <button
                    onClick={() => setMarkdownZoomLevel(prev => Math.min(2.0, prev + 0.1))}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title={t('editorPanel.zoomIn')}
                  >
                    <ZoomIn size={12} />
                  </button>
                </div>
              )}
              <button
                onClick={() => { setIsLatexPreviewMode(!isLatexPreviewMode); setIsPreviewMode(false); setIsRichTextMode(false); }}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={isLatexPreviewMode ? 'Hide live LaTeX preview' : 'Show live LaTeX preview (subset, read-only)'}
              >
                <Eye size={12} style={{ color: isLatexPreviewMode ? '#4daafc' : 'inherit' }} />
              </button>
              <button
                onClick={() => setShowSnippetsPanel(!showSnippetsPanel)}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title="Insert LaTeX snippet"
              >
                <PlusSquare size={12} style={{ color: showSnippetsPanel ? '#4daafc' : 'inherit' }} />
              </button>
            </>
          )}

          {selectedFile && selectedFile.toLowerCase().endsWith('.md') && (
            <>
              {isPreviewMode && (
                <>
                  <button
                    onClick={handlePrintPDF}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title="Imprimir / Exportar PDF"
                  >
                    <Printer size={12} />
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                    <button
                      onClick={() => setMarkdownZoomLevel(prev => Math.max(0.5, prev - 0.1))}
                      className="vscode-bottom-panel-clear-btn"
                      style={{ padding: '6px' }}
                      title="Diminuir zoom"
                    >
                      <ZoomOut size={12} />
                    </button>
                    <span style={{ fontSize: '11px', minWidth: '35px', textAlign: 'center', color: 'var(--vscode-text-fg)' }}>
                      {Math.round(markdownZoomLevel * 100)}%
                    </span>
                    <button
                      onClick={() => setMarkdownZoomLevel(prev => Math.min(2.0, prev + 0.1))}
                      className="vscode-bottom-panel-clear-btn"
                      style={{ padding: '6px' }}
                      title="Aumentar zoom"
                    >
                      <ZoomIn size={12} />
                    </button>
                  </div>
                </>
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

          {isTexFile && (
            <button
              onClick={() => setShowLatexHelp(true)}
              className="vscode-bottom-panel-clear-btn"
              style={{ padding: '6px' }}
              title={t('editorPanel.latexHelpTitle')}
              aria-label={t('editorPanel.latexHelpTitle')}
              aria-expanded={showLatexHelp}
            >
              <HelpCircle size={12} style={{ color: showLatexHelp ? '#4daafc' : 'inherit' }} />
            </button>
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
          <div style={{ height: '100%', background: 'var(--vscode-editor-bg)' }}>
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
        ) : isDocxFile ? (
          <Suspense
            fallback={(
              <div className="docx-editor-host docx-editor-empty">
                <RefreshCw size={18} className="animate-spin" />
                <span>{t('docxEditor.loading')}</span>
              </div>
            )}
          >
            <DocxEditorPanel
              ref={docxEditorRef}
              activeProject={activeProject}
              selectedFile={selectedFile}
              theme={theme}
              onSaved={onBinaryFileSaved}
            />
          </Suspense>
        ) : isPptxFile ? (
          <Suspense
            fallback={(
              <div className="pptx-editor-host pptx-editor-loading">
                <RefreshCw size={18} className="animate-spin" />
                <span>{t('pptxEditor.loading', 'Loading presentation...')}</span>
              </div>
            )}
          >
            <PptxEditorPanel
              ref={pptxEditorRef}
              activeProject={activeProject}
              selectedFile={selectedFile}
              theme={theme}
              onSaved={onBinaryFileSaved}
            />
          </Suspense>
        ) : isTexFile && isPdfPreviewCollapsed ? (
          renderTexEditorSurface()
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
          {renderTexEditorSurface()}
          <div style={{ height: '100%', background: 'var(--vscode-editor-bg)', borderLeft: '1px solid var(--vscode-border)' }}>
            <PdfPreview 
              ref={pdfPreviewRef}
              base64Pdf={null}
              sourceUrl={pdfUrl}
              isCompiling={isCompiling} 
              errorLog={pdfErrorLog} 
              activeProject={activeProject}
              selectedFile={selectedFile}
              onSyncTexNavigate={handleSyncTexNavigate}
              onDocumentReady={handlePdfDocumentReady}
              onCollapse={() => setIsPdfPreviewCollapsed(true)}
            />
          </div>
          </Split>
        ) : (
          <div className="vscode-editor-container" style={{ position: 'relative', height: '100%' }}>
            {isPreviewMode ? (
              <div style={{ padding: '20px', overflowY: 'auto', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, boxSizing: 'border-box' }} className="markdown-preview-container">
                {formatMessageContent(fileContent, activeProject?.project_path, markdownZoomLevel)}
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
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                beforeMount={handleBeforeMount}
                onMount={handleMount}
                options={{
                  contextmenu: false,
                  fontSize: editorFontSize,
                  lineNumbers: 'on',
                  tabSize: editorTabSize,
                  wordWrap: editorWordWrap,
                  automaticLayout: true,
                  renderSideBySide: true,
                  readOnly: false,
                  originalEditable: false,
                  fixedOverflowWidgets: true,
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
                  contextmenu: false,
                  fontSize: editorFontSize,
                  lineNumbers: 'on',
                  tabSize: editorTabSize,
                  wordWrap: editorWordWrap,
                  automaticLayout: true,
                  fixedOverflowWidgets: true,
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

      {showLatexHelp && (
        <div className="latex-help-modal-backdrop" onClick={() => setShowLatexHelp(false)}>
          <div
            className="latex-help-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('editorPanel.latexHelpTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="latex-help-header">
              <span>{t('editorPanel.latexHelpTitle')}</span>
              <button
                onClick={() => setShowLatexHelp(false)}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '3px' }}
                title={t('editorPanel.latexHelpClose')}
                aria-label={t('editorPanel.latexHelpClose')}
              >
                <X size={12} />
              </button>
            </div>
            <div className="latex-help-section-title">{t('editorPanel.latexHelpShortcutsTitle')}</div>
            <dl className="latex-help-list">
              <div>
                <dt>Ctrl+S</dt>
                <dd>{t('editorPanel.latexHelpSave')}</dd>
              </div>
              <div>
                <dt>Ctrl+L</dt>
                <dd>{t('editorPanel.latexHelpInline')}</dd>
              </div>
              <div>
                <dt>Ctrl+J</dt>
                <dd>{t('editorPanel.latexHelpTerminal')}</dd>
              </div>
              <div>
                <dt>Ctrl/Alt+Click</dt>
                <dd>{t('editorPanel.latexHelpSyncTex')}</dd>
              </div>
            </dl>
            <div className="latex-help-section-title">{t('editorPanel.latexHelpFeaturesTitle')}</div>
            <ul className="latex-help-feature-list">
              <li>{t('editorPanel.latexHelpCompile')}</li>
              <li>{t('editorPanel.latexHelpPartial')}</li>
              <li>{t('editorPanel.latexHelpRichText')}</li>
              <li>{t('editorPanel.latexHelpPreview')}</li>
              <li>{t('editorPanel.latexHelpSnippets')}</li>
            </ul>
          </div>
        </div>
      )}

      {/* Custom editor context menu (replaces Monaco's Shadow DOM menu) */}
      {editorContextMenu && (
        <EditorContextMenuOverlay
          menu={editorContextMenu}
          onClose={() => setEditorContextMenu(null)}
          setInlinePrompt={setInlinePrompt}
          t={t}
        />
      )}
    </div>
  );
}
