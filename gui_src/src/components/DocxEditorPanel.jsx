import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { RefreshCw, Save, Sigma, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TextSelection } from 'prosemirror-state';
import { DocxEditor } from '@docx-editor.dev/react';
import enDocxLocale from '../../vendor/docx-editor/i18n/en';
import ptBRDocxLocale from '../../vendor/docx-editor/i18n/pt-BR';
import {
  mathmlForOmml,
  mathmlPlainText,
  mathmlToLatex,
  mathmlToOmml,
  ommlParagraphJustification,
} from '@docx-editor.dev/core/math';
import InlinePromptOverlay from './InlinePromptOverlay';
import MathEquationEditor from './MathEquationEditor';
import '../../vendor/docx-editor/react/styles/editor.compiled.css';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX_BROWSER_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function extractInlineReplacement(responseText) {
  let rawResponse = String(responseText || '').trim();
  rawResponse = rawResponse.replace(/\{"result"\s*:\s*"[^"]*"\}\s*/g, '');
  rawResponse = rawResponse.replace(/\{"error"\s*:\s*"[^"]*"\}\s*/g, '');

  try {
    const parsed = JSON.parse(rawResponse);
    if (parsed?.name && parsed?.arguments?.content) {
      rawResponse = parsed.arguments.content;
    }
  } catch {
    const contentMatch = rawResponse.match(/"content"\s*:\s*"([\s\S]*)/);
    if (contentMatch) {
      let str = contentMatch[1];
      str = str.replace(/\"\s*\}?\s*\}?\s*$/, '');
      str = str.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\t/g, '\t');
      rawResponse = str;
    }
  }

  rawResponse = rawResponse
    .replace(/^````(?:thought|reasoning)[\s\S]*?````\s*/, '')
    .replace(/^```(?:thought|reasoning)[\s\S]*?```\s*/, '')
    .trim();

  const match4 = /^````(\w*)\n([\s\S]*?)\n````\s*$/m.exec(rawResponse);
  if (match4) return match4[2];

  const match3 = /^```(\w*)\n([\s\S]*?)\n```\s*$/m.exec(rawResponse);
  if (match3) return match3[2];

  return rawResponse
    .replace(/^````?\w*\n?/, '')
    .replace(/\n?````?\s*$/, '')
    .trim();
}

function stripMarkdownFence(text) {
  const raw = String(text || '').trim();
  const match4 = /^````(?:json|content)?\n([\s\S]*?)\n````\s*$/m.exec(raw);
  if (match4) return match4[1].trim();
  const match3 = /^```(?:json|content)?\n([\s\S]*?)\n```\s*$/m.exec(raw);
  if (match3) return match3[1].trim();
  return raw;
}

function parseStructuredRefineResponse(responseText) {
  const raw = stripMarkdownFence(extractInlineReplacement(responseText));
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.paragraphs)) return null;
    return parsed.paragraphs
      .map((item) => ({
        id: String(item?.id || ''),
        text: String(item?.text ?? ''),
      }))
      .filter((item) => item.id);
  } catch {
    return null;
  }
}

function getFirstTextMarks(node) {
  let marks = null;
  node.descendants((child) => {
    if (marks || !child.isText) return false;
    marks = child.marks || [];
    return false;
  });
  return marks || [];
}

function collectDocxSelectionStructure(editor, selectionRange) {
  const view = editor?.getEditorRef?.()?.getView?.();
  if (!view || !selectionRange) return null;

  const { doc } = view.state;
  const docSize = doc.content.size;
  const from = Math.max(0, Math.min(selectionRange.from, docSize));
  const to = Math.max(from, Math.min(selectionRange.to, docSize));
  if (from === to) return null;

  const paragraphs = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;

    const contentStart = pos + 1;
    const contentEnd = pos + node.content.size;
    const selectedFrom = Math.max(from, contentStart);
    const selectedTo = Math.min(to, contentEnd);
    if (selectedFrom >= selectedTo) return false;

    const selectedText = node.textBetween(
      selectedFrom - contentStart,
      selectedTo - contentStart,
      '\n',
      ' '
    );
    if (!selectedText.trim()) return false;

    const attrs = node.attrs || {};
    const listKind = attrs.numPr?.numId ? (attrs.listIsBullet ? 'bullet' : 'numbered') : 'none';

    paragraphs.push({
      id: attrs.paraId || `p${paragraphs.length + 1}`,
      index: paragraphs.length,
      type: node.type.name,
      listKind,
      listLevel: attrs.numPr?.ilvl ?? null,
      styleId: attrs.styleId || null,
      selectedText,
      fullText: node.textBetween(0, node.content.size, '\n', ' '),
      from: selectedFrom,
      to: selectedTo,
      marks: getFirstTextMarks(node),
    });

    return false;
  });

  if (!paragraphs.length) return null;
  return {
    from,
    to,
    isStructureAware: paragraphs.length > 1 || paragraphs.some((item) => item.listKind !== 'none'),
    paragraphs,
  };
}

function replaceDocxSelectionWithText(editor, selectionRange, replacementText) {
  const view = editor?.getEditorRef?.()?.getView?.();
  if (!view || !selectionRange || !replacementText) return false;

  const docSize = view.state.doc.content.size;
  const from = Math.max(0, Math.min(selectionRange.from, docSize));
  const to = Math.max(from, Math.min(selectionRange.to, docSize));
  if (from === to) return false;

  const selection = TextSelection.create(view.state.doc, from, to);
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  view.focus();

  const normalized = String(replacementText).replace(/\r\n?/g, '\n');
  try {
    const data = new DataTransfer();
    data.setData('text/plain', normalized);
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(event);
    if (event.defaultPrevented) return true;
  } catch {
    // Fall through to direct text insertion when synthetic paste is unavailable.
  }

  view.dispatch(view.state.tr.insertText(normalized.replace(/\n+/g, ' '), from, to).scrollIntoView());
  return true;
}

function applyStructuredDocxRefine(editor, structure, replacements) {
  const view = editor?.getEditorRef?.()?.getView?.();
  if (!view || !structure?.paragraphs?.length || !Array.isArray(replacements)) return false;

  const byId = new Map(replacements.map((item) => [String(item.id), String(item.text ?? '')]));
  if (structure.paragraphs.some((paragraph) => !byId.has(String(paragraph.id)))) return false;

  let tr = view.state.tr;
  const schema = view.state.schema;
  const ordered = [...structure.paragraphs].sort((a, b) => b.from - a.from);

  for (const paragraph of ordered) {
    const rawText = byId.get(String(paragraph.id));
    if (rawText == null) return false;
    const text = rawText.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').trim();
    if (text) {
      tr = tr.replaceWith(paragraph.from, paragraph.to, schema.text(text, paragraph.marks || []));
    } else {
      tr = tr.deleteRange(paragraph.from, paragraph.to);
    }
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

function formatSelectionStructureForPrompt(structure) {
  return JSON.stringify({
    kind: 'docx-selection',
    editingRules: [
      'Return the same paragraphs array length and ids.',
      'Rewrite only each paragraph text value.',
      'Do not add bullets, numbering prefixes, markdown markers, or DOCX XML.',
      'Keep list items as list items; the editor will preserve their Word paragraph formatting.',
    ],
    paragraphs: structure.paragraphs.map((paragraph) => ({
      id: paragraph.id,
      index: paragraph.index,
      type: paragraph.type,
      listKind: paragraph.listKind,
      listLevel: paragraph.listLevel,
      styleId: paragraph.styleId,
      text: paragraph.selectedText,
    })),
  }, null, 2);
}

/**
 * The painted equation under a pointer event, if the event landed on one.
 * The painter tags every equation span with `layout-run-math` and the
 * ProseMirror positions of the node it came from.
 */
function paintedEquationAt(target) {
  if (!(target instanceof Element)) return null;
  const element = target.closest('.layout-run-math');
  if (!element) return null;

  const from = Number(element.getAttribute('data-doc-from'));
  const to = Number(element.getAttribute('data-doc-to'));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { element, from, to };
}

/** The `math` node at a document position, or null if something else is there. */
function mathNodeAt(view, from) {
  if (!view) return null;
  const node = view.state.doc.nodeAt(from);
  return node && node.type.name === 'math' ? node : null;
}

/** Rect of `element` in the coordinate space of `host`. */
function rectWithin(element, host) {
  const elementRect = element.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  return {
    left: elementRect.left - hostRect.left,
    top: elementRect.top - hostRect.top,
    width: elementRect.width,
    height: elementRect.height,
  };
}

const DocxEditorPanel = forwardRef(function DocxEditorPanel({
  activeProject,
  selectedFile,
  theme,
  onSaved,
}, ref) {
  const { t, i18n } = useTranslation();
  const editorRef = useRef(null);
  const [documentBuffer, setDocumentBuffer] = useState(undefined);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [inlinePrompt, setInlinePrompt] = useState(null);
  const [docVersion, setDocVersion] = useState(0);
  const hostRef = useRef(null);
  const [equationEditor, setEquationEditor] = useState(null);

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

  const resolveDocxMedia = useCallback(async (file) => {
    const mimeType = String(file?.mimeType || '').toLowerCase();
    if (!mimeType || DOCX_BROWSER_IMAGE_MIMES.has(mimeType)) return undefined;
    if (!mimeType.startsWith('image/')) return undefined;
    if (!file?.data) return undefined;

    const response = await fetch('/api/docx/render-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mimeType,
        filename: file.filename || file.path || 'image',
        dataBase64: arrayBufferToBase64(file.data),
      }),
    });
    if (!response.ok) return undefined;
    const payload = await response.json().catch(() => null);
    if (!payload?.success || !payload.data_base64 || !payload.mime) return undefined;
    return `data:${payload.mime};base64,${payload.data_base64}`;
  }, []);

  const handleSave = useCallback(async (bufferFromEditor = null) => {
    if (!editorRef.current && !bufferFromEditor) return false;
    setIsSaving(true);
    setStatus(t('docxEditor.saving', 'Saving DOCX...'));
    try {
      const buffer = bufferFromEditor || await editorRef.current.save();
      await saveBuffer(buffer);
      setStatus(t('docxEditor.saved', 'DOCX saved.'));
      onSaved?.(selectedFile);
      setTimeout(() => setStatus(''), 2000);
      return true;
    } catch (error) {
      setStatus(t('docxEditor.saveFailed', 'DOCX save failed: {{error}}', {
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [onSaved, saveBuffer, selectedFile, t]);

  useImperativeHandle(ref, () => ({
    save: () => handleSave(),
  }), [handleSave]);

  /**
   * Open the equation editor on the equation the user double-clicked.
   *
   * The document keeps the equation as OMML; the editor needs LaTeX, so it is
   * converted through MathML — the same pipeline the painter renders with.
   */
  const openEquationEditor = useCallback((equation) => {
    const view = editorRef.current?.getEditorRef?.()?.getView?.();
    const host = hostRef.current;
    if (!view || !host) return;

    const node = mathNodeAt(view, equation.from);
    if (!node) return;

    const ommlXml = node.attrs.ommlXml || '';
    const display = node.attrs.display === 'block' ? 'block' : 'inline';
    const mathml = mathmlForOmml(ommlXml, display);
    const latex = mathml ? mathmlToLatex(mathml) : '';

    setEquationEditor({
      mode: 'edit',
      from: equation.from,
      to: equation.to,
      latex,
      display,
      // Word keeps a display equation's justification on the equation itself;
      // regenerating the OMML without it would silently re-center one the
      // author had aligned left.
      justification: ommlParagraphJustification(ommlXml) ?? undefined,
      anchorRect: rectWithin(equation.element, host),
      hostSize: { width: host.clientWidth, height: host.clientHeight },
    });
  }, []);

  /** Insert a new equation at the caret. */
  const openEquationInsert = useCallback(() => {
    const view = editorRef.current?.getEditorRef?.()?.getView?.();
    const host = hostRef.current;
    if (!view || !host) {
      setStatus(t('docxEditor.equation.editorUnavailable', 'Open a DOCX before inserting an equation.'));
      setTimeout(() => setStatus(''), 2500);
      return;
    }

    const { from, to } = view.state.selection;
    setEquationEditor({
      mode: 'insert',
      from,
      to,
      latex: '',
      display: 'inline',
      anchorRect: null,
      hostSize: { width: host.clientWidth, height: host.clientHeight },
    });
  }, [t]);

  /**
   * Write the edited equation back into the document.
   *
   * Only the equation that was actually edited is regenerated: every other
   * equation keeps the OMML Word wrote, with the properties MathML cannot
   * carry (`m:ctrlPr`, alignment hints) intact.
   */
  const commitEquation = useCallback(
    ({ mathml, latex, display }) => {
      const view = editorRef.current?.getEditorRef?.()?.getView?.();
      const target = equationEditor;
      if (!view || !target) return;

      // Applying an empty equation means "remove it", the way Word treats an
      // equation you delete the contents of — not a conversion failure.
      if (!String(latex || '').trim()) {
        if (target.mode === 'edit') {
          view.dispatch(view.state.tr.delete(target.from, target.to).scrollIntoView());
        }
        view.focus();
        setEquationEditor(null);
        return;
      }

      const mathType = view.state.schema.nodes.math;
      if (!mathType) {
        setStatus(t('docxEditor.equation.unsupported', 'This document editor has no equation node.'));
        setTimeout(() => setStatus(''), 2500);
        return;
      }

      const ommlXml = mathmlToOmml(mathml, {
        display,
        ...(target.justification ? { justification: target.justification } : {}),
      });
      if (!ommlXml) {
        setStatus(t('docxEditor.equation.convertFailed', 'Could not convert the equation to Word format.'));
        setTimeout(() => setStatus(''), 3000);
        return;
      }

      const node = mathType.create({
        display,
        ommlXml,
        plainText: mathmlPlainText(mathml),
      });

      try {
        if (target.mode === 'edit') {
          // The node's own range: replacing exactly it keeps every surrounding
          // mark and paragraph property untouched.
          const size = view.state.doc.content.size;
          const from = Math.min(target.from, size);
          const to = Math.min(Math.max(target.to, from), size);
          view.dispatch(view.state.tr.replaceWith(from, to, node).scrollIntoView());
        } else {
          // Inserting goes through replaceSelectionWith, which knows how to fit
          // an inline node into whatever the user had selected — a range across
          // two paragraphs is not something replaceWith could take.
          view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
        }
      } catch (error) {
        setStatus(
          t('docxEditor.equation.insertFailed', 'Could not place the equation: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          })
        );
        setTimeout(() => setStatus(''), 3000);
        return;
      }

      view.focus();
      setEquationEditor(null);
    },
    [equationEditor, t]
  );

  // Word opens an equation on double-click; so does this. The handler runs in
  // the capture phase so the editor's own double-click (select the word under
  // the pointer) never fires on an equation.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const handleDoubleClick = (event) => {
      const equation = paintedEquationAt(event.target);
      if (!equation) return;
      event.preventDefault();
      event.stopPropagation();
      openEquationEditor(equation);
    };

    host.addEventListener('dblclick', handleDoubleClick, true);
    return () => host.removeEventListener('dblclick', handleDoubleClick, true);
  }, [openEquationEditor, documentBuffer]);

  const openRefinePrompt = useCallback(() => {
    const selectionInfo = editorRef.current?.getSelectionInfo?.();
    const selectedText = selectionInfo?.selectedText || '';
    const view = editorRef.current?.getEditorRef?.()?.getView?.();
    const selection = view?.state?.selection;
    if (!selectedText.trim() || !selection || selection.from === selection.to) {
      setStatus(t('docxEditor.selectTextToRefine', 'Select text in the DOCX before refining.'));
      setTimeout(() => setStatus(''), 2500);
      return;
    }

    setInlinePrompt({
      mode: 'refine',
      selectedText,
      startLine: 1,
      endLine: 1,
      cursorCol: 1,
      locationLabel: t('docxEditor.selectionLabel', 'DOCX selection'),
      defaultInstruction: t('docxEditor.inlinePromptRefineDefault', 'Refine the selected content'),
      selectionRange: { from: selection.from, to: selection.to },
      selectionStructure: collectDocxSelectionStructure(editorRef.current, {
        from: selection.from,
        to: selection.to,
      }),
      paragraphText: selectionInfo.paragraphText || '',
      before: selectionInfo.before || '',
      after: selectionInfo.after || '',
    });
  }, [t]);

  const handleRefineSubmit = useCallback(async (instruction) => {
    if (!inlinePrompt || !activeProject) return;
    setIsRefining(true);
    setStatus(t('docxEditor.refining', 'Refining DOCX selection...'));

    const selectedText = inlinePrompt.selectedText || '';
    const selectionStructure = inlinePrompt.selectionStructure;
    const useStructuredRefine = !!selectionStructure?.isStructureAware;
    const paragraphContext = inlinePrompt.paragraphText && !useStructuredRefine
      ? `Paragraph Context:\n""""\n${inlinePrompt.paragraphText}\n""""\n\n`
      : '';

    const systemPrompt = useStructuredRefine
      ? "You are a precise inline editor for Microsoft Word DOCX prose. " +
        "CRITICAL: Do NOT create, modify, or save files. " +
        "The user selected structured DOCX content. Preserve the document structure. " +
        "Return ONLY JSON wrapped in a FOUR-BACKTICK fenced block: ````json\\n{\"paragraphs\":[{\"id\":\"...\",\"text\":\"...\"}]}\\n````. " +
        "You MUST use exactly four backticks (````), never three (```). " +
        "Return the same paragraph ids and the same number/order of paragraph objects. " +
        "Rewrite only the text values. Do not include bullet characters, numbering prefixes, Markdown markers, DOCX XML, explanations, or any text outside the fenced JSON. " +
        "Preserve the original language, meaning, citations, item count, paragraph role, and formatting intent unless the requested edit explicitly requires different wording."
      : "You are a precise inline editor for Microsoft Word DOCX prose. " +
        "CRITICAL: Do NOT create, modify, or save files. " +
        "Return ONLY the final replacement text wrapped in a FOUR-BACKTICK fenced block: ````content\\n...\\n````. " +
        "You MUST use exactly four backticks (````), never three (```). " +
        "Do NOT include greetings, explanations, comments, summaries, or any text before or after the fenced block. " +
        "Preserve the original language, meaning, paragraph role, citations, numbering text, and formatting intent unless the requested edit requires changes. " +
        "Do not return DOCX XML, Markdown, LaTeX, or code unless the selected text itself is code.";

    const prompt = useStructuredRefine
      ? `Task: ${instruction}\n\nDOCX Selection Structure:\n\`\`\`\n${formatSelectionStructureForPrompt(selectionStructure)}\n\`\`\`\n\nReturn JSON only in this exact shape:\n{"paragraphs":[{"id":"same-id","text":"refined text only"}]}`
      : `Task: ${instruction}\n\n${paragraphContext}Target Selection to Replace:\n""""\n${selectedText}\n""""`;

    try {
      const response = await fetch('/api/opalatex/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'run',
          agent: 'inline_editor',
          model: activeProject.model,
          project_name: activeProject.name,
          project_path: activeProject.project_path,
          system_prompt: systemPrompt,
          tools: [],
          prompt,
          current_file: selectedFile || '',
          editor_content: inlinePrompt.paragraphText || '',
          selected_text: selectedText,
          lang: i18n.language || 'en',
          model_params: { max_tokens: 4096 },
        }),
      });

      if (!response.body) throw new Error(t('app.streamUnsupportedBackground', 'Streaming is not supported by this browser.'));

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let agentResponse = '';
      let errorMessage = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.event === 'agent_response' && data.response) agentResponse = data.response;
            if (data.event === 'error' || data.event === 'problem') errorMessage = data.message || errorMessage;
          } catch {
            // Ignore non-JSON stream lines.
          }
        }
      }

      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer);
          if (data.event === 'agent_response' && data.response) agentResponse = data.response;
          if (data.event === 'error' || data.event === 'problem') errorMessage = data.message || errorMessage;
        } catch {
          // Ignore trailing non-JSON stream data.
        }
      }

      if (!agentResponse) {
        throw new Error(errorMessage || t('app.inlineAgentNoOutput', 'Inline agent finished without producing content.'));
      }

      let applied = false;
      if (useStructuredRefine) {
        const replacements = parseStructuredRefineResponse(agentResponse);
        if (replacements) {
          applied = applyStructuredDocxRefine(editorRef.current, selectionStructure, replacements);
        }
      }

      if (!applied) {
        const replacement = extractInlineReplacement(agentResponse);
        if (!replacement.trim()) throw new Error(t('docxEditor.emptyRefineResult', 'The refine result was empty.'));
        applied = replaceDocxSelectionWithText(editorRef.current, inlinePrompt.selectionRange, replacement);
      }

      if (!applied) throw new Error(t('docxEditor.applyRefineFailed', 'Could not apply the refined text to the DOCX selection.'));

      setStatus(t('docxEditor.refineApplied', 'DOCX refine applied.'));
      setTimeout(() => setStatus(''), 2000);
    } catch (error) {
      setStatus(t('docxEditor.refineFailed', 'DOCX refine failed: {{error}}', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setInlinePrompt(null);
      setIsRefining(false);
    }
  }, [activeProject, i18n.language, inlinePrompt, selectedFile, t]);

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
    <div className="docx-editor-host" ref={hostRef}>
      {equationEditor && (
        <MathEquationEditor
          key={`${equationEditor.mode}-${equationEditor.from}`}
          initialLatex={equationEditor.latex}
          display={equationEditor.display}
          anchorRect={equationEditor.anchorRect}
          hostSize={equationEditor.hostSize}
          onCommit={commitEquation}
          onCancel={() => setEquationEditor(null)}
        />
      )}
      {inlinePrompt && (
        <InlinePromptOverlay
          inlinePrompt={inlinePrompt}
          onSubmit={handleRefineSubmit}
          onClose={() => setInlinePrompt(null)}
          onCancel={() => setInlinePrompt(null)}
          isRunning={isRefining}
        />
      )}
      <DocxEditor
        key={docVersion}
        ref={editorRef}
        documentBuffer={documentBuffer}
        mediaResolver={resolveDocxMedia}
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
              onClick={openEquationInsert}
              title={t('docxEditor.equation.insert', 'Insert equation')}
            >
              <Sigma size={12} />
            </button>
            <button
              type="button"
              className="vscode-button"
              onClick={openRefinePrompt}
              disabled={isRefining}
              title={t('docxEditor.refineSelection', 'Refine selection')}
            >
              {isRefining ? <RefreshCw size={12} className="animate-spin" /> : <Wand2 size={12} />}
            </button>
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
});

export default DocxEditorPanel;
