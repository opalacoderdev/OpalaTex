/**
 * SlideCanvas
 *
 * Renders a single slide's elements on a scaled HTML surface.
 * Supports element selection, dragging, resizing, and inline text editing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';


// ── EMU Conversion ───────────────────────────────────────────────────────────

const EMU_PER_INCH = 914400;
const EMU_PER_PT = 12700;

function emuToPx(emu, scale = 1) {
  return (emu / EMU_PER_INCH) * 96 * scale;
}

function pxToEmu(px, scale = 1) {
  return (px / Math.max(scale, 0.0001) / 96) * EMU_PER_INCH;
}

function fontSizePtFromHundredths(hundredths) {
  // OOXML stores font size in hundredths of a point, e.g. 1800 = 18pt
  return hundredths / 100;
}

function spacingPtFromHundredths(hundredths) {
  return hundredths / 100;
}

// ── Fill to CSS ──────────────────────────────────────────────────────────────

function fillToCss(fill) {
  if (!fill) return 'transparent';
  if (fill.type === 'none') return 'transparent';
  if (fill.type === 'solid') {
    const alpha = fill.alpha !== undefined ? fill.alpha / 100000 : 1;
    if (alpha < 1) {
      const r = parseInt(fill.color.substring(0, 2), 16);
      const g = parseInt(fill.color.substring(2, 4), 16);
      const b = parseInt(fill.color.substring(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return `#${fill.color}`;
  }
  if (fill.type === 'gradient' && fill.stops?.length > 0) {
    const angle = fill.angle !== undefined ? fill.angle / 60000 : 90;
    const stops = fill.stops
      .map((s) => `#${s.color} ${s.position / 1000}%`)
      .join(', ');
    return `linear-gradient(${angle}deg, ${stops})`;
  }
  return 'transparent';
}

// ── Text Body Renderer ──────────────────────────────────────────────────────

function TextBodyRenderer({ textBody, scale = 1, onTextChange, isEditing }) {
  const ref = useRef(null);
  const editingRef = useRef(false);

  const paragraphText = useCallback((paragraph) => (
    paragraph.children
      .map((child) => ('type' in child && child.type === 'break' ? '\n' : child.text))
      .join('')
  ), []);

  const commitText = useCallback(() => {
    if (!onTextChange || !ref.current) return;
    const paras = Array.from(ref.current.querySelectorAll('[data-pptx-edit-paragraph]'))
      .map((node) => node.textContent || '');
    onTextChange(paras);
  }, [onTextChange]);

  useEffect(() => {
    if (!isEditing) editingRef.current = false;
  }, [isEditing]);

  if (!textBody || textBody.paragraphs.length === 0) return null;

  const bp = textBody.bodyProperties || {};
  const vertAlign = bp.anchor === 'middle' ? 'center' : bp.anchor === 'bottom' ? 'flex-end' : 'flex-start';

  return (
    <div
      ref={ref}
      className="pptx-text-body"
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: vertAlign,
        width: '100%',
        height: '100%',
        padding: `${emuToPx(bp.tIns ?? 45720, scale)}px ${emuToPx(bp.rIns ?? 91440, scale)}px ${emuToPx(bp.bIns ?? 45720, scale)}px ${emuToPx(bp.lIns ?? 91440, scale)}px`,
        overflow: 'hidden',
        boxSizing: 'border-box',
        color: '#000000',
      }}
    >
      {textBody.paragraphs.map((p, pi) => {
        const align = p.properties?.alignment || 'left';
        const bullet = p.properties?.bulletChar;
        const firstRun = p.children.find((child) => !('type' in child));
        const firstRunProperties = firstRun?.properties || {};
        const runStyle = {
          fontWeight: firstRunProperties.bold ? 'bold' : undefined,
          fontStyle: firstRunProperties.italic ? 'italic' : undefined,
          textDecoration: [
            firstRunProperties.underline ? 'underline' : '',
            firstRunProperties.strikethrough ? 'line-through' : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined,
          fontSize: firstRunProperties.fontSize
            ? `${fontSizePtFromHundredths(firstRunProperties.fontSize) * scale}pt`
            : undefined,
          fontFamily: firstRunProperties.fontFamily || undefined,
          color: firstRunProperties.color ? `#${firstRunProperties.color}` : '#000000',
        };
        const paragraphMarginLeft = p.properties?.marginLeft !== undefined
          ? emuToPx(p.properties.marginLeft, scale)
          : (p.properties?.level ? p.properties.level * emuToPx(457200, scale) : 0);
        const paragraphIndent = p.properties?.indent !== undefined
          ? emuToPx(p.properties.indent, scale)
          : 0;
        const paragraphStyle = {
          textAlign: align,
          marginLeft: paragraphMarginLeft ? `${paragraphMarginLeft}px` : undefined,
          textIndent: !bullet && paragraphIndent ? `${paragraphIndent}px` : undefined,
          marginTop: p.properties?.spaceBefore ? `${spacingPtFromHundredths(p.properties.spaceBefore) * scale}pt` : 0,
          marginBottom: p.properties?.spaceAfter ? `${spacingPtFromHundredths(p.properties.spaceAfter) * scale}pt` : 0,
          minHeight: '1em',
          lineHeight: p.properties?.lineSpacing && p.properties.lineSpacing > 1000
            ? p.properties.lineSpacing / 100000
            : 1.18,
          display: bullet ? 'flex' : undefined,
          alignItems: bullet ? 'flex-start' : undefined,
          gap: bullet ? `${8 * scale}px` : undefined,
        };

        return (
          <div
            key={pi}
            style={paragraphStyle}
          >
            {bullet && (
              <span
                contentEditable={false}
                style={{
                  ...runStyle,
                  flex: '0 0 auto',
                  minWidth: `${18 * scale}px`,
                  textAlign: 'right',
                  lineHeight: 'inherit',
                }}
              >
                {bullet}
              </span>
            )}
            <span
              data-pptx-edit-paragraph
              contentEditable={isEditing}
              suppressContentEditableWarning
              onFocus={() => { editingRef.current = true; }}
              onBlur={() => {
                editingRef.current = false;
                commitText();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              style={{
                ...(bullet ? { flex: '1 1 auto' } : undefined),
                ...runStyle,
                outline: isEditing ? 'none' : undefined,
                whiteSpace: 'pre-wrap',
              }}
            >
              {paragraphText(p)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Element Renderer ─────────────────────────────────────────────────────────

function ElementRenderer({
  element,
  scale,
  mediaCache,
  isSelected,
  isEditing,
  onSelect,
  onDoubleClick,
  onDragStart,
  onResizeStart,
  onTextChange,
}) {
  const t = element.transform;
  const style = {
    position: 'absolute',
    left: `${emuToPx(t.x, scale)}px`,
    top: `${emuToPx(t.y, scale)}px`,
    width: `${emuToPx(t.width, scale)}px`,
    height: `${emuToPx(t.height, scale)}px`,
    transform: t.rotation ? `rotate(${t.rotation / 60000}deg)` : undefined,
    cursor: 'default',
    outline: isSelected ? '2px solid #4472C4' : undefined,
    outlineOffset: isSelected ? '-1px' : undefined,
    zIndex: isSelected ? 10 : undefined,
  };

  if (element.type === 'picture') {
    const src = element.dataUri || (element.mediaPath && mediaCache?.[element.mediaPath]);
    return (
      <div
        style={style}
        onClick={(e) => { e.stopPropagation(); onSelect?.(element); }}
        onDoubleClick={(e) => { e.stopPropagation(); }}
        onMouseDown={(e) => { if (isSelected) onDragStart?.(e, element); }}
      >
        {src ? (
          <img
            src={src}
            alt={element.name}
            style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
            draggable={false}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: `${12 * scale}px`, color: '#999' }}>
            Image
          </div>
        )}
        {isSelected && <SelectionHandles onResizeStart={onResizeStart} element={element} />}
      </div>
    );
  }

  if (element.type === 'shape') {
    const bg = fillToCss(element.fill);
    const borderRadius = element.geometry === 'ellipse' ? '50%'
      : element.geometry === 'roundRect' ? `${emuToPx(Math.min(t.width, t.height) * 0.1, scale)}px`
      : undefined;

    const lineStyle = element.line
      ? `${emuToPx(element.line.width, scale)}px solid ${element.line.fill ? fillToCss(element.line.fill) : '#000'}`
      : undefined;

    return (
      <div
        style={{
          ...style,
          background: bg,
          borderRadius,
          border: lineStyle,
        }}
        onClick={(e) => { e.stopPropagation(); onSelect?.(element); }}
        onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(element); }}
        onMouseDown={(e) => { if (isSelected && !isEditing) onDragStart?.(e, element); }}
      >
        {element.textBody && (
          <TextBodyRenderer
            textBody={element.textBody}
            scale={scale}
            isEditing={isEditing}
            onTextChange={onTextChange ? (paras) => onTextChange(element, paras) : undefined}
          />
        )}
        {isSelected && !isEditing && <SelectionHandles onResizeStart={onResizeStart} element={element} />}
      </div>
    );
  }

  if (element.type === 'group') {
    return (
      <div
        style={style}
        onClick={(e) => { e.stopPropagation(); onSelect?.(element); }}
      >
        {element.children.map((child, i) => (
          <ElementRenderer
            key={child.id || i}
            element={child}
            scale={scale}
            mediaCache={mediaCache}
            isSelected={false}
            isEditing={false}
            onSelect={onSelect}
          />
        ))}
        {isSelected && <SelectionHandles onResizeStart={onResizeStart} element={element} />}
      </div>
    );
  }

  if (element.type === 'table') {
    return (
      <div
        style={style}
        onClick={(e) => { e.stopPropagation(); onSelect?.(element); }}
      >
        <table
          style={{
            width: '100%',
            height: '100%',
            borderCollapse: 'collapse',
            tableLayout: 'fixed',
          }}
        >
          <tbody>
            {element.rows.map((row, ri) => (
              <tr key={ri} style={{ height: `${emuToPx(row.height, scale)}px` }}>
                {row.cells.map((cell, ci) => (
                  <td
                    key={ci}
                    style={{
                      background: cell.fill ? fillToCss(cell.fill) : undefined,
                      border: `${1 * scale}px solid #ccc`,
                      padding: `${2 * scale}px`,
                      verticalAlign: 'top',
                      fontSize: `${10 * scale}pt`,
                    }}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                  >
                    {cell.textBody && (
                      <TextBodyRenderer textBody={cell.textBody} scale={scale} isEditing={false} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {isSelected && <SelectionHandles onResizeStart={onResizeStart} element={element} />}
      </div>
    );
  }

  return null;
}

// ── Selection Handles ────────────────────────────────────────────────────────

function SelectionHandles({ element, onResizeStart }) {
  const handleStyle = {
    position: 'absolute',
    width: '8px',
    height: '8px',
    background: '#fff',
    border: '2px solid #4472C4',
    borderRadius: '2px',
    boxSizing: 'border-box',
  };

  const handleMouseDown = (event, direction) => {
    event.preventDefault();
    event.stopPropagation();
    onResizeStart?.(event, element, direction);
  };

  return (
    <>
      <div onMouseDown={(event) => handleMouseDown(event, 'nw')} style={{ ...handleStyle, top: '-4px', left: '-4px', cursor: 'nwse-resize' }} />
      <div onMouseDown={(event) => handleMouseDown(event, 'ne')} style={{ ...handleStyle, top: '-4px', right: '-4px', cursor: 'nesw-resize' }} />
      <div onMouseDown={(event) => handleMouseDown(event, 'sw')} style={{ ...handleStyle, bottom: '-4px', left: '-4px', cursor: 'nesw-resize' }} />
      <div onMouseDown={(event) => handleMouseDown(event, 'se')} style={{ ...handleStyle, bottom: '-4px', right: '-4px', cursor: 'nwse-resize' }} />
      <div onMouseDown={(event) => handleMouseDown(event, 'n')} style={{ ...handleStyle, top: '-4px', left: '50%', transform: 'translateX(-50%)', cursor: 'ns-resize' }} />
      <div onMouseDown={(event) => handleMouseDown(event, 's')} style={{ ...handleStyle, bottom: '-4px', left: '50%', transform: 'translateX(-50%)', cursor: 'ns-resize' }} />
      <div onMouseDown={(event) => handleMouseDown(event, 'w')} style={{ ...handleStyle, top: '50%', left: '-4px', transform: 'translateY(-50%)', cursor: 'ew-resize' }} />
      <div onMouseDown={(event) => handleMouseDown(event, 'e')} style={{ ...handleStyle, top: '50%', right: '-4px', transform: 'translateY(-50%)', cursor: 'ew-resize' }} />
    </>
  );
}

// ── Main Canvas ──────────────────────────────────────────────────────────────

export default function SlideCanvas({
  slide,
  presentationSize,
  mediaCache,
  selectedElementId,
  editingElementId,
  onSelectElement,
  onDeselectAll,
  onDoubleClickElement,
  onElementDragStart,
  onElementResize,
  onTextChange,
  zoom = 1,
  thumbnail = false,
}) {
  const containerRef = useRef(null);
  const lastScaleRef = useRef(1);
  const [scale, setScale] = useState(1);

  // Compute scale to fit the canvas in the container
  useEffect(() => {
    if (!containerRef.current || !presentationSize) return;
    const container = containerRef.current;

    const observer = new ResizeObserver(() => {
      const padding = thumbnail ? 0 : 40;
      const cw = container.clientWidth - padding;
      const ch = container.clientHeight - padding;
      const slideW = presentationSize.width / EMU_PER_INCH * 96;
      const slideH = presentationSize.height / EMU_PER_INCH * 96;
      const fitScale = Math.min(cw / slideW, ch / slideH, thumbnail ? 1 : 1.5);
      const nextScale = Math.max(0.05, Number((fitScale * zoom).toFixed(4)));
      if (Math.abs(nextScale - lastScaleRef.current) > 0.001) {
        lastScaleRef.current = nextScale;
        setScale(nextScale);
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [presentationSize, zoom, thumbnail]);

  const handleResizeStart = useCallback((event, element, direction) => {
    if (!element || !onElementResize) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...element.transform };
    const minSize = 914400 * 0.25;

    onElementResize(element, start, { begin: true });

    const handleMove = (moveEvent) => {
      const dx = pxToEmu(moveEvent.clientX - startX, scale);
      const dy = pxToEmu(moveEvent.clientY - startY, scale);
      const next = { ...start };

      if (direction.includes('e')) next.width = Math.max(minSize, start.width + dx);
      if (direction.includes('s')) next.height = Math.max(minSize, start.height + dy);
      if (direction.includes('w')) {
        const width = Math.max(minSize, start.width - dx);
        next.x = start.x + (start.width - width);
        next.width = width;
      }
      if (direction.includes('n')) {
        const height = Math.max(minSize, start.height - dy);
        next.y = start.y + (start.height - height);
        next.height = height;
      }

      onElementResize(element, next, { begin: false });
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [onElementResize, scale]);

  const handleDragStart = useCallback((event, element) => {
    if (!element || !onElementResize || editingElementId === element.id) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...element.transform };

    onElementResize(element, start, { begin: true });

    const handleMove = (moveEvent) => {
      const dx = pxToEmu(moveEvent.clientX - startX, scale);
      const dy = pxToEmu(moveEvent.clientY - startY, scale);
      onElementResize(element, {
        ...start,
        x: start.x + dx,
        y: start.y + dy,
      }, { begin: false });
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [onElementResize, scale, editingElementId]);

  if (!slide) {
    return (
      <div ref={containerRef} className="pptx-canvas-container">
        <div className="pptx-canvas-empty">No slide selected</div>
      </div>
    );
  }

  const slideW = emuToPx(presentationSize.width, scale);
  const slideH = emuToPx(presentationSize.height, scale);

  const bgCss = slide.background?.fill
    ? fillToCss(slide.background.fill)
    : '#FFFFFF';

  return (
    <div
      ref={containerRef}
      className={`pptx-canvas-container${thumbnail ? ' pptx-canvas-thumbnail' : ''}`}
      onClick={() => onDeselectAll?.()}
    >
      <div
        className="pptx-canvas-slide"
        style={{
          width: `${slideW}px`,
          height: `${slideH}px`,
          background: bgCss,
          position: 'relative',
          boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
          overflow: 'hidden',
        }}
      >
        {slide.elements.map((el, i) => (
          <ElementRenderer
            key={el.id || i}
            element={el}
            scale={scale}
            mediaCache={mediaCache}
            isSelected={el.id === selectedElementId}
            isEditing={el.id === editingElementId}
            onSelect={onSelectElement}
            onDoubleClick={onDoubleClickElement}
            onDragStart={onElementDragStart || handleDragStart}
            onResizeStart={handleResizeStart}
            onTextChange={onTextChange}
          />
        ))}
      </div>
    </div>
  );
}
