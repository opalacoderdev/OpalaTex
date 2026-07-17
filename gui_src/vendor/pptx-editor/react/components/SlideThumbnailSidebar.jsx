/**
 * SlideThumbnail Sidebar
 *
 * Displays a vertical list of scaled-down slide previews. Supports:
 * - Click to select a slide
 * - Right-click context menu (add, duplicate, delete)
 * - Drag-and-drop reorder
 */
import { useCallback, useRef, useState } from 'react';
import { Plus, Copy, Trash2, GripVertical } from 'lucide-react';
import SlideCanvas from './SlideCanvas';

export default function SlideThumbnailSidebar({
  slides,
  presentationSize,
  mediaCache,
  selectedSlideIndex,
  onSelectSlide,
  onAddSlide,
  onDuplicateSlide,
  onDeleteSlide,
  onReorderSlide,
}) {
  const [contextMenu, setContextMenu] = useState(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const handleContextMenu = useCallback((e, index) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectSlide(index);
    setContextMenu({ x: e.clientX, y: e.clientY, index });
  }, [onSelectSlide]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Drag-and-drop
  const handleDragStart = useCallback((e, index) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((e, toIndex) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      onReorderSlide?.(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, onReorderSlide]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  return (
    <div className="pptx-thumbnail-sidebar" onClick={closeContextMenu}>
      <div className="pptx-thumbnail-header">
        <span className="pptx-thumbnail-title">Slides</span>
        <button
          className="pptx-thumbnail-add-btn"
          onClick={() => onAddSlide?.()}
          title="Add Slide"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="pptx-thumbnail-list">
        {slides.map((slide, index) => {
          const isSelected = index === selectedSlideIndex;
          const isDragOver = index === dragOverIndex && dragIndex !== index;

          return (
            <div
              key={slide.xmlPath || index}
              className={`pptx-thumbnail-item ${isSelected ? 'pptx-thumbnail-selected' : ''} ${isDragOver ? 'pptx-thumbnail-drag-over' : ''}`}
              onClick={() => onSelectSlide(index)}
              onContextMenu={(e) => handleContextMenu(e, index)}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
            >
              <span className="pptx-thumbnail-number">{index + 1}</span>
              <div className="pptx-thumbnail-preview">
                <SlideCanvas
                  slide={slide}
                  presentationSize={presentationSize}
                  mediaCache={mediaCache}
                  selectedElementId={null}
                  editingElementId={null}
                  thumbnail
                />
              </div>
              <div className="pptx-thumbnail-grip">
                <GripVertical size={12} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="pptx-context-menu"
          style={{
            position: 'fixed',
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
            zIndex: 9999,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="pptx-context-menu-item"
            onClick={() => { onAddSlide?.(contextMenu.index + 1); closeContextMenu(); }}
          >
            <Plus size={14} />
            <span>Add Slide After</span>
          </button>
          <button
            className="pptx-context-menu-item"
            onClick={() => { onDuplicateSlide?.(contextMenu.index); closeContextMenu(); }}
          >
            <Copy size={14} />
            <span>Duplicate Slide</span>
          </button>
          {slides.length > 1 && (
            <button
              className="pptx-context-menu-item pptx-context-menu-item-danger"
              onClick={() => { onDeleteSlide?.(contextMenu.index); closeContextMenu(); }}
            >
              <Trash2 size={14} />
              <span>Delete Slide</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
