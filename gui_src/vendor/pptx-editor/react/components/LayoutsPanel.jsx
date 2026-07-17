/**
 * LayoutsPanel
 *
 * Displays available slide layouts from the PPTX template as thumbnails,
 * allowing the user to apply a layout to the current slide or insert a
 * new slide based on a layout. Similar to Google Slides' layout picker.
 */
import { useCallback } from 'react';
import { LayoutTemplate, Plus, Check } from 'lucide-react';
import SlideCanvas from './SlideCanvas';

export default function LayoutsPanel({
  layouts,
  presentationSize,
  mediaCache,
  currentLayoutPath,
  onApplyLayout,
  onInsertSlideFromLayout,
  visible = true,
  onToggle,
}) {
  const handleApply = useCallback((layout) => {
    onApplyLayout?.(layout);
  }, [onApplyLayout]);

  const handleInsert = useCallback((layout) => {
    onInsertSlideFromLayout?.(layout);
  }, [onInsertSlideFromLayout]);

  if (!visible) {
    return (
      <div className="pptx-layouts-panel-collapsed">
        <button
          className="pptx-layouts-toggle"
          onClick={onToggle}
          title="Show layouts"
        >
          <LayoutTemplate size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="pptx-layouts-panel">
      <div className="pptx-layouts-header">
        <span className="pptx-layouts-title">
          <LayoutTemplate size={14} />
          Layouts
        </span>
        <button
          className="pptx-layouts-toggle"
          onClick={onToggle}
          title="Hide layouts"
        >
          ✕
        </button>
      </div>
      <div className="pptx-layouts-list">
        {layouts && layouts.length > 0 ? (
          layouts.map((layout, index) => {
            const isActive = currentLayoutPath === layout.path;
            return (
              <div
                key={layout.path || index}
                className={`pptx-layout-item${isActive ? ' pptx-layout-item-active' : ''}`}
                onClick={() => handleApply(layout)}
                title={layout.name}
              >
                <div className="pptx-layout-thumbnail">
                  <SlideCanvas
                    slide={{
                      elements: [],
                      layoutElements: layout.elements,
                      background: layout.background,
                      masterElements: [],
                      number: 0,
                      xmlPath: '',
                      relsPath: '',
                    }}
                    presentationSize={presentationSize}
                    mediaCache={mediaCache}
                    selectedElementId={null}
                    editingElementId={null}
                    zoom={1}
                    thumbnail
                  />
                </div>
                <div className="pptx-layout-label">
                  <span className="pptx-layout-name">{layout.name}</span>
                  {isActive && <Check size={12} className="pptx-layout-check" />}
                </div>
                <button
                  className="pptx-layout-add-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleInsert(layout);
                  }}
                  title="Insert new slide with this layout"
                >
                  <Plus size={12} />
                </button>
              </div>
            );
          })
        ) : (
          <div className="pptx-layouts-empty">
            No layouts available in this template.
          </div>
        )}
      </div>
    </div>
  );
}