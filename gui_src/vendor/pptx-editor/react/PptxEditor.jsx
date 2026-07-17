/**
 * PptxEditor
 *
 * Main editor component that composes the slide toolbar, thumbnail sidebar,
 * and slide canvas into a unified editing workspace.
 *
 * This component manages the core editing state: selected slide, selected
 * element, undo/redo history, and dispatches modifications to the slide model.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parsePptx, serializePptx, createBlankSlide } from '@pptx-editor/core';
import SlideCanvas from './components/SlideCanvas';
import SlideThumbnailSidebar from './components/SlideThumbnailSidebar';
import SlideToolbar from './components/SlideToolbar';
import LayoutsPanel from './components/LayoutsPanel';

// Maximum number of undo snapshots to keep
const MAX_UNDO_HISTORY = 50;

function clampFontSizePt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(6, Math.min(144, Math.round(parsed)));
}

function normalizeHexColor(color) {
  return String(color || '').replace('#', '').trim().toUpperCase();
}

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read image file.'));
    reader.readAsDataURL(file);
  });
}

function imageSizeFromDataUri(dataUri) {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth || 960, height: img.naturalHeight || 540 });
    img.onerror = () => resolve({ width: 960, height: 540 });
    img.src = dataUri;
  });
}

export default function PptxEditor({
  documentBuffer,
  colorMode = 'dark',
  onSave,
  onError,
}) {
  // ── Presentation State ───────────────────────────────────────────────────
  const [presentation, setPresentation] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedSlideIndex, setSelectedSlideIndex] = useState(0);
  const [selectedElementId, setSelectedElementId] = useState(null);
  const [editingElementId, setEditingElementId] = useState(null);
  const [modifiedSlides, setModifiedSlides] = useState(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [zoom, setZoom] = useState(1);
  const [isPresenting, setIsPresenting] = useState(false);
  const [layoutsPanelVisible, setLayoutsPanelVisible] = useState(false);

  // Undo/redo
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const transformGestureRef = useRef(false);

  // ── Parse on Mount ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!documentBuffer) return;
    let cancelled = false;
    setIsLoading(true);
    setLoadError('');

    parsePptx(documentBuffer)
      .then((pres) => {
        if (cancelled) return;
        console.log('[PptxEditor] Parsed presentation:', {
          slideCount: pres.slides.length,
          size: pres.size,
          slides: pres.slides.map((s, i) => ({
            number: s.number,
            elementCount: s.elements.length,
            elements: s.elements.map(el => ({
              type: el.type,
              id: el.id,
              name: el.name,
              w: el.transform?.width,
              h: el.transform?.height,
            })),
          })),
        });
        setPresentation(pres);
        setSelectedSlideIndex(0);
        setSelectedElementId(null);
        setEditingElementId(null);
        setModifiedSlides(new Set());
        setUndoStack([]);
        setRedoStack([]);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[PptxEditor] Parse error:', msg, err);
        setLoadError(msg);
        setIsLoading(false);
        onError?.(err);
      });

    return () => { cancelled = true; };
  }, [documentBuffer, onError]);

  // ── Derived State ────────────────────────────────────────────────────────
  const currentSlide = presentation?.slides?.[selectedSlideIndex] ?? null;
  const selectedElement = useMemo(() => {
    if (!currentSlide || !selectedElementId) return null;
    return currentSlide.elements.find((element) => element.id === selectedElementId) ?? null;
  }, [currentSlide, selectedElementId]);

  const selectedFontSizePt = useMemo(() => {
    if (selectedElement?.type !== 'shape' || !selectedElement.textBody) return '';
    for (const paragraph of selectedElement.textBody.paragraphs) {
      for (const child of paragraph.children) {
        if ('type' in child && child.type === 'break') continue;
        if (child.properties?.fontSize) {
          return Math.round(child.properties.fontSize / 100);
        }
      }
    }
    return '';
  }, [selectedElement]);

  // ── Snapshot for Undo ────────────────────────────────────────────────────
  const pushUndo = useCallback(() => {
    if (!presentation) return;
    // Deep-clone slides (without zipInstance which is large)
    const snapshot = JSON.parse(JSON.stringify(presentation.slides));
    setUndoStack((prev) => {
      const next = [...prev, snapshot];
      return next.length > MAX_UNDO_HISTORY ? next.slice(-MAX_UNDO_HISTORY) : next;
    });
    setRedoStack([]);
  }, [presentation]);

  const undo = useCallback(() => {
    if (undoStack.length === 0 || !presentation) return;
    const snapshot = undoStack[undoStack.length - 1];
    const currentSnapshot = JSON.parse(JSON.stringify(presentation.slides));

    setRedoStack((prev) => [...prev, currentSnapshot]);
    setUndoStack((prev) => prev.slice(0, -1));
    setPresentation((prev) => ({ ...prev, slides: snapshot }));
    // Mark all slides as modified after undo
    setModifiedSlides(new Set(snapshot.map((_, i) => i)));
  }, [undoStack, presentation]);

  const redo = useCallback(() => {
    if (redoStack.length === 0 || !presentation) return;
    const snapshot = redoStack[redoStack.length - 1];
    const currentSnapshot = JSON.parse(JSON.stringify(presentation.slides));

    setUndoStack((prev) => [...prev, currentSnapshot]);
    setRedoStack((prev) => prev.slice(0, -1));
    setPresentation((prev) => ({ ...prev, slides: snapshot }));
    setModifiedSlides(new Set(snapshot.map((_, i) => i)));
  }, [redoStack, presentation]);

  // ── Slide Management ─────────────────────────────────────────────────────
  const addSlide = useCallback((atIndex) => {
    if (!presentation) return;
    pushUndo();
    const idx = atIndex ?? presentation.slides.length;
    const newSlide = createBlankSlide(idx + 1);
    const updatedSlides = [...presentation.slides];
    updatedSlides.splice(idx, 0, newSlide);
    // Re-number
    updatedSlides.forEach((s, i) => { s.number = i + 1; });
    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setSelectedSlideIndex(idx);
    setSelectedElementId(null);
    setEditingElementId(null);
    setModifiedSlides((prev) => new Set([...prev, idx]));
  }, [presentation, pushUndo]);

  const duplicateSlide = useCallback((index) => {
    if (!presentation || !presentation.slides[index]) return;
    pushUndo();
    const original = presentation.slides[index];
    const clone = JSON.parse(JSON.stringify(original));
    clone.number = index + 2;
    clone.rawXml = undefined; // Force re-serialization
    const updatedSlides = [...presentation.slides];
    updatedSlides.splice(index + 1, 0, clone);
    updatedSlides.forEach((s, i) => { s.number = i + 1; });
    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setSelectedSlideIndex(index + 1);
    setModifiedSlides((prev) => new Set([...prev, index + 1]));
  }, [presentation, pushUndo]);

  const deleteSlide = useCallback((index) => {
    if (!presentation || presentation.slides.length <= 1) return;
    pushUndo();
    const updatedSlides = presentation.slides.filter((_, i) => i !== index);
    updatedSlides.forEach((s, i) => { s.number = i + 1; });
    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    const newIdx = Math.min(index, updatedSlides.length - 1);
    setSelectedSlideIndex(newIdx);
    setSelectedElementId(null);
    setEditingElementId(null);
    // All remaining slides are potentially modified (XML paths may shift)
    setModifiedSlides(new Set(updatedSlides.map((_, i) => i)));
  }, [presentation, pushUndo]);

  const reorderSlide = useCallback((fromIndex, toIndex) => {
    if (!presentation) return;
    pushUndo();
    const updatedSlides = [...presentation.slides];
    const [moved] = updatedSlides.splice(fromIndex, 1);
    updatedSlides.splice(toIndex, 0, moved);
    updatedSlides.forEach((s, i) => { s.number = i + 1; });
    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setSelectedSlideIndex(toIndex);
    setModifiedSlides(new Set(updatedSlides.map((_, i) => i)));
  }, [presentation, pushUndo]);

  // ── Element Selection ────────────────────────────────────────────────────
  const selectElement = useCallback((element) => {
    setSelectedElementId(element?.id ?? null);
    if (editingElementId && element?.id !== editingElementId) {
      setEditingElementId(null);
    }
  }, [editingElementId]);

  const deselectAll = useCallback(() => {
    setSelectedElementId(null);
    setEditingElementId(null);
  }, []);

  const doubleClickElement = useCallback((element) => {
    if (element?.type === 'shape' && element.textBody) {
      setEditingElementId(element.id);
    }
  }, []);

  // ── Text Editing ─────────────────────────────────────────────────────────
  const handleTextChange = useCallback((element, paragraphTexts) => {
    if (!presentation || !currentSlide) return;
    pushUndo();

    // Update the element's text body
    const updatedElements = currentSlide.elements.map((el) => {
      if (el.id !== element.id || el.type !== 'shape' || !el.textBody) return el;
      const updatedParagraphs = el.textBody.paragraphs.map((p, i) => {
        if (i >= paragraphTexts.length) return p;
        return {
          ...p,
          children: [{ text: paragraphTexts[i], properties: p.children[0]?.properties }],
        };
      });
      return {
        ...el,
        textBody: { ...el.textBody, paragraphs: updatedParagraphs },
        rawXml: undefined,
      };
    });

    const updatedSlides = [...presentation.slides];
    updatedSlides[selectedSlideIndex] = {
      ...currentSlide,
      elements: updatedElements,
      rawXml: undefined,
    };

    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setModifiedSlides((prev) => new Set([...prev, selectedSlideIndex]));
  }, [presentation, currentSlide, selectedSlideIndex, pushUndo]);

  const handleElementResize = useCallback((element, transform, options = {}) => {
    if (!presentation || !currentSlide || !element) return;
    if (options.begin || !transformGestureRef.current) {
      pushUndo();
      transformGestureRef.current = true;
    }

    const updatedElements = currentSlide.elements.map((el) => {
      if (el.id !== element.id) return el;
      return {
        ...el,
        transform: { ...transform },
      };
    });

    const updatedSlides = [...presentation.slides];
    updatedSlides[selectedSlideIndex] = {
      ...currentSlide,
      elements: updatedElements,
      rawXml: undefined,
    };

    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setModifiedSlides((prev) => new Set([...prev, selectedSlideIndex]));

    window.clearTimeout(transformGestureRef.current?.timeoutId);
    transformGestureRef.current = {
      timeoutId: window.setTimeout(() => {
        transformGestureRef.current = false;
      }, 250),
    };
  }, [presentation, currentSlide, selectedSlideIndex, pushUndo]);

  // ── Insert Helpers ───────────────────────────────────────────────────────
  const insertShape = useCallback((geometry, fill) => {
    if (!presentation || !currentSlide) return;
    pushUndo();

    const newEl = {
      type: 'shape',
      id: `shape_${Date.now()}`,
      name: geometry === 'ellipse' ? 'Ellipse' : 'Rectangle',
      transform: { x: 2286000, y: 2286000, width: 2286000, height: 1524000 },
      geometry,
      fill: fill || { type: 'solid', color: '4472C4' },
      textBody: {
        paragraphs: [{ children: [], properties: {} }],
        bodyProperties: { anchor: 'middle' },
      },
    };

    const updatedSlides = [...presentation.slides];
    updatedSlides[selectedSlideIndex] = {
      ...currentSlide,
      elements: [...currentSlide.elements, newEl],
      rawXml: undefined,
    };

    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setModifiedSlides((prev) => new Set([...prev, selectedSlideIndex]));
    setSelectedElementId(newEl.id);
  }, [presentation, currentSlide, selectedSlideIndex, pushUndo]);

  const insertTextBox = useCallback(() => {
    insertShape('rect', { type: 'none' });
  }, [insertShape]);

  const updateSelectedShape = useCallback((updater) => {
    if (!presentation || !currentSlide || !selectedElementId) return;
    pushUndo();

    const updatedElements = currentSlide.elements.map((el) => {
      if (el.id !== selectedElementId || el.type !== 'shape') return el;
      return updater(el);
    });

    const updatedSlides = [...presentation.slides];
    updatedSlides[selectedSlideIndex] = {
      ...currentSlide,
      elements: updatedElements,
      rawXml: undefined,
    };

    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setModifiedSlides((prev) => new Set([...prev, selectedSlideIndex]));
  }, [presentation, currentSlide, selectedElementId, selectedSlideIndex, pushUndo]);

  const updateSelectedTextRuns = useCallback((updater) => {
    updateSelectedShape((shape) => {
      if (!shape.textBody) return shape;
      return {
        ...shape,
        textBody: {
          ...shape.textBody,
          paragraphs: shape.textBody.paragraphs.map((paragraph) => ({
            ...paragraph,
            children: paragraph.children.map((child) => {
              if ('type' in child && child.type === 'break') return child;
              return {
                ...child,
                properties: updater(child.properties || {}),
              };
            }),
          })),
        },
      };
    });
  }, [updateSelectedShape]);

  const toggleRunProperty = useCallback((property) => {
    updateSelectedTextRuns((props) => ({
      ...props,
      [property]: !props[property],
    }));
  }, [updateSelectedTextRuns]);

  const setTextColor = useCallback((color) => {
    const normalized = normalizeHexColor(color);
    if (!/^[0-9A-F]{6}$/.test(normalized)) return;
    updateSelectedTextRuns((props) => ({ ...props, color: normalized }));
  }, [updateSelectedTextRuns]);

  const setFontSize = useCallback((value) => {
    const fontSizePt = clampFontSizePt(value);
    if (!fontSizePt) return;
    updateSelectedTextRuns((props) => ({ ...props, fontSize: fontSizePt * 100 }));
  }, [updateSelectedTextRuns]);

  const setParagraphAlignment = useCallback((alignment) => {
    updateSelectedShape((shape) => {
      if (!shape.textBody) return shape;
      return {
        ...shape,
        textBody: {
          ...shape.textBody,
          paragraphs: shape.textBody.paragraphs.map((paragraph) => ({
            ...paragraph,
            properties: {
              ...(paragraph.properties || {}),
              alignment,
            },
          })),
        },
      };
    });
  }, [updateSelectedShape]);

  const insertImage = useCallback(async (file) => {
    if (!presentation || !currentSlide || !file) return;
    try {
      const dataUri = await fileToDataUri(file);
      const size = await imageSizeFromDataUri(dataUri);
      pushUndo();

      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const idSeed = Date.now();
      const mediaPath = `ppt/media/opalatex-image-${idSeed}.${ext}`;
      const rId = `rIdOpalaTexImage${idSeed}`;
      const maxWidth = presentation.size.width * 0.55;
      const maxHeight = presentation.size.height * 0.55;
      const aspect = size.width / Math.max(size.height, 1);
      let width = maxWidth;
      let height = width / aspect;
      if (height > maxHeight) {
        height = maxHeight;
        width = height * aspect;
      }

      const newEl = {
        type: 'picture',
        id: `picture_${idSeed}`,
        name: file.name || 'Image',
        transform: {
          x: Math.round((presentation.size.width - width) / 2),
          y: Math.round((presentation.size.height - height) / 2),
          width: Math.round(width),
          height: Math.round(height),
        },
        rId,
        mediaPath,
        dataUri,
      };

      const updatedSlides = [...presentation.slides];
      updatedSlides[selectedSlideIndex] = {
        ...currentSlide,
        elements: [...currentSlide.elements, newEl],
        rawXml: undefined,
      };

      setPresentation((prev) => ({
        ...prev,
        slides: updatedSlides,
        mediaCache: {
          ...(prev.mediaCache || {}),
          [mediaPath]: dataUri,
        },
      }));
      setModifiedSlides((prev) => new Set([...prev, selectedSlideIndex]));
      setSelectedElementId(newEl.id);
      setStatus('Image inserted.');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Image insert failed: ${msg}`);
      onError?.(err);
    }
  }, [presentation, currentSlide, selectedSlideIndex, pushUndo, onError]);

  const zoomIn = useCallback(() => {
    setZoom((value) => Math.min(2.5, Math.round((value + 0.1) * 10) / 10));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((value) => Math.max(0.4, Math.round((value - 0.1) * 10) / 10));
  }, []);

  const startPresenterMode = useCallback(() => {
    setIsPresenting(true);
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  const stopPresenterMode = useCallback(() => {
    setIsPresenting(false);
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  // ── Layout Management ───────────────────────────────────────────────────
  const applyLayout = useCallback((layout) => {
    if (!presentation || !currentSlide) return;
    pushUndo();

    const updatedSlides = [...presentation.slides];
    updatedSlides[selectedSlideIndex] = {
      ...currentSlide,
      layoutPath: layout.path,
      layoutElements: JSON.parse(JSON.stringify(layout.elements || [])),
      layoutBackground: layout.background,
      rawXml: undefined,
    };

    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setModifiedSlides((prev) => new Set([...prev, selectedSlideIndex]));
    setStatus(`Layout applied: ${layout.name}`);
    setTimeout(() => setStatus(''), 2000);
  }, [presentation, currentSlide, selectedSlideIndex, pushUndo]);

  const insertSlideFromLayout = useCallback((layout) => {
    if (!presentation) return;
    pushUndo();
    const idx = selectedSlideIndex + 1;
    const newSlide = {
      number: idx + 1,
      xmlPath: `ppt/slides/slide${idx + 1}.xml`,
      relsPath: `ppt/slides/_rels/slide${idx + 1}.xml.rels`,
      layoutPath: layout.path,
      layoutElements: JSON.parse(JSON.stringify(layout.elements || [])),
      layoutBackground: layout.background,
      elements: [],
      rawXml: undefined,
    };
    const updatedSlides = [...presentation.slides];
    updatedSlides.splice(idx, 0, newSlide);
    updatedSlides.forEach((s, i) => { s.number = i + 1; });
    setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
    setSelectedSlideIndex(idx);
    setSelectedElementId(null);
    setEditingElementId(null);
    setModifiedSlides((prev) => new Set([...prev, idx]));
    setStatus(`New slide from layout: ${layout.name}`);
    setTimeout(() => setStatus(''), 2000);
  }, [presentation, selectedSlideIndex, pushUndo]);

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!presentation || !onSave) return;
    setIsSaving(true);
    setStatus('Saving...');
    try {
      const buffer = await serializePptx(presentation, modifiedSlides);
      await onSave(buffer);
      setModifiedSlides(new Set());
      setStatus('Saved.');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Save failed: ${msg}`);
      onError?.(err);
    } finally {
      setIsSaving(false);
    }
  }, [presentation, modifiedSlides, onSave, onError]);

  // ── Keyboard Shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 's') {
        e.preventDefault();
        handleSave();
      } else if (ctrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (ctrl && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleRunProperty('bold');
      } else if (ctrl && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        toggleRunProperty('italic');
      } else if (ctrl && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        toggleRunProperty('underline');
      } else if (e.key === 'F5') {
        e.preventDefault();
        startPresenterMode();
      } else if (e.key === 'Escape' && isPresenting) {
        e.preventDefault();
        stopPresenterMode();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedElementId && !editingElementId && presentation && currentSlide) {
          e.preventDefault();
          pushUndo();
          const updatedElements = currentSlide.elements.filter((el) => el.id !== selectedElementId);
          const updatedSlides = [...presentation.slides];
          updatedSlides[selectedSlideIndex] = {
            ...currentSlide,
            elements: updatedElements,
            rawXml: undefined,
          };
          setPresentation((prev) => ({ ...prev, slides: updatedSlides }));
          setModifiedSlides((prev) => new Set([...prev, selectedSlideIndex]));
          setSelectedElementId(null);
        }
      } else if (e.key === 'Escape') {
        if (editingElementId) {
          setEditingElementId(null);
        } else {
          setSelectedElementId(null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, undo, redo, toggleRunProperty, startPresenterMode, stopPresenterMode, isPresenting, selectedElementId, editingElementId, presentation, currentSlide, selectedSlideIndex, pushUndo]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className={`pptx-editor-host pptx-editor-error ${colorMode}`}>
        <p>Could not load presentation: {loadError}</p>
      </div>
    );
  }

  if (isLoading || !presentation) {
    return (
      <div className={`pptx-editor-host pptx-editor-loading ${colorMode}`}>
        <div className="pptx-loading-spinner" />
        <span>Loading presentation...</span>
      </div>
    );
  }

  return (
    <div className={`pptx-editor-host ${colorMode}`}>
      <SlideToolbar
        onSave={handleSave}
        isSaving={isSaving}
        onUndo={undo}
        onRedo={redo}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onInsertTextBox={insertTextBox}
        onInsertRect={() => insertShape('rect')}
        onInsertEllipse={() => insertShape('ellipse')}
        onInsertImage={insertImage}
        onBold={() => toggleRunProperty('bold')}
        onItalic={() => toggleRunProperty('italic')}
        onUnderline={() => toggleRunProperty('underline')}
        onFontColor={setTextColor}
        fontSizePt={selectedFontSizePt}
        onFontSizeChange={setFontSize}
        onAlignLeft={() => setParagraphAlignment('left')}
        onAlignCenter={() => setParagraphAlignment('center')}
        onAlignRight={() => setParagraphAlignment('right')}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onToggleLayouts={() => setLayoutsPanelVisible((v) => !v)}
        onPresenterMode={startPresenterMode}
        status={status}
      />

      <div className="pptx-editor-body">
        <SlideThumbnailSidebar
          slides={presentation.slides}
          presentationSize={presentation.size}
          mediaCache={presentation.mediaCache}
          selectedSlideIndex={selectedSlideIndex}
          onSelectSlide={setSelectedSlideIndex}
          onAddSlide={addSlide}
          onDuplicateSlide={duplicateSlide}
          onDeleteSlide={deleteSlide}
          onReorderSlide={reorderSlide}
        />

        <SlideCanvas
          slide={currentSlide}
          presentationSize={presentation.size}
          mediaCache={presentation.mediaCache}
          selectedElementId={selectedElementId}
          editingElementId={editingElementId}
          onSelectElement={selectElement}
          onDeselectAll={deselectAll}
          onDoubleClickElement={doubleClickElement}
          onTextChange={handleTextChange}
          onElementResize={handleElementResize}
          zoom={zoom}
        />

        <LayoutsPanel
          layouts={presentation.availableLayouts || []}
          presentationSize={presentation.size}
          mediaCache={presentation.mediaCache}
          currentLayoutPath={currentSlide?.layoutPath}
          onApplyLayout={applyLayout}
          onInsertSlideFromLayout={insertSlideFromLayout}
          visible={layoutsPanelVisible}
          onToggle={() => setLayoutsPanelVisible((v) => !v)}
        />
      </div>

      {isPresenting && (
        <div className="pptx-presenter-overlay" onClick={stopPresenterMode}>
          <button
            className="pptx-presenter-close"
            onClick={(event) => {
              event.stopPropagation();
              stopPresenterMode();
            }}
            title="Exit presentation"
          >
            Exit
          </button>
          <div className="pptx-presenter-stage" onClick={(event) => event.stopPropagation()}>
            <SlideCanvas
              slide={currentSlide}
              presentationSize={presentation.size}
              mediaCache={presentation.mediaCache}
              selectedElementId={null}
              editingElementId={null}
              zoom={2.5}
            />
          </div>
        </div>
      )}
    </div>
  );
}
