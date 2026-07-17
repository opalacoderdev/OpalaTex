/**
 * SlideToolbar
 *
 * Formatting toolbar for the slide editor with text styling, shape insertion,
 * and slide management actions.
 */
import { useRef } from 'react';
import {
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Type,
  Square,
  Circle,
  Image,
  Palette,
  Save,
  RefreshCw,
  Presentation,
  Undo2,
  Redo2,
  Minus,
  Plus,
} from 'lucide-react';

export default function SlideToolbar({
  onSave,
  isSaving,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onBold,
  onItalic,
  onUnderline,
  onAlignLeft,
  onAlignCenter,
  onAlignRight,
  onInsertTextBox,
  onInsertRect,
  onInsertEllipse,
  onInsertImage,
  onFontColor,
  fontSizePt,
  onFontSizeChange,
  onPresenterMode,
  onZoomIn,
  onZoomOut,
  status,
}) {
  const fileInputRef = useRef(null);

  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleImageChange = (event) => {
    const file = event.target.files?.[0];
    if (file) onInsertImage?.(file);
    event.target.value = '';
  };

  const handleColorChange = (event) => {
    onFontColor?.(event.target.value);
  };

  const handleFontSizeChange = (event) => {
    onFontSizeChange?.(event.target.value);
  };

  return (
    <div className="pptx-toolbar">
      {/* File Actions */}
      <div className="pptx-toolbar-group">
        <button
          className="pptx-toolbar-btn"
          onClick={onSave}
          disabled={isSaving}
          title="Save (Ctrl+S)"
        >
          {isSaving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
        </button>
        <button
          className="pptx-toolbar-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={16} />
        </button>
        <button
          className="pptx-toolbar-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 size={16} />
        </button>
      </div>

      <div className="pptx-toolbar-separator" />

      {/* Text Formatting */}
      <div className="pptx-toolbar-group">
        <label className="pptx-font-size-control" title="Font Size">
          <Type size={14} />
          <input
            type="number"
            min="6"
            max="144"
            step="1"
            value={fontSizePt ?? ''}
            onChange={handleFontSizeChange}
            placeholder="--"
          />
        </label>
        <button className="pptx-toolbar-btn" onClick={onBold} title="Bold (Ctrl+B)">
          <Bold size={16} />
        </button>
        <button className="pptx-toolbar-btn" onClick={onItalic} title="Italic (Ctrl+I)">
          <Italic size={16} />
        </button>
        <button className="pptx-toolbar-btn" onClick={onUnderline} title="Underline (Ctrl+U)">
          <Underline size={16} />
        </button>
        <label className="pptx-color-btn" title="Text Color">
          <Palette size={15} />
          <input type="color" defaultValue="#000000" onChange={handleColorChange} />
        </label>
      </div>

      <div className="pptx-toolbar-separator" />

      {/* Alignment */}
      <div className="pptx-toolbar-group">
        <button className="pptx-toolbar-btn" onClick={onAlignLeft} title="Align Left">
          <AlignLeft size={16} />
        </button>
        <button className="pptx-toolbar-btn" onClick={onAlignCenter} title="Align Center">
          <AlignCenter size={16} />
        </button>
        <button className="pptx-toolbar-btn" onClick={onAlignRight} title="Align Right">
          <AlignRight size={16} />
        </button>
      </div>

      <div className="pptx-toolbar-separator" />

      {/* Insert */}
      <div className="pptx-toolbar-group">
        <button className="pptx-toolbar-btn" onClick={onInsertTextBox} title="Insert Text Box">
          <Type size={16} />
        </button>
        <button className="pptx-toolbar-btn" onClick={onInsertRect} title="Insert Rectangle">
          <Square size={16} />
        </button>
        <button className="pptx-toolbar-btn" onClick={onInsertEllipse} title="Insert Ellipse">
          <Circle size={16} />
        </button>
        <button className="pptx-toolbar-btn" onClick={handleImageClick} title="Insert Image">
          <Image size={16} />
        </button>
        <input
          ref={fileInputRef}
          className="pptx-hidden-file-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          onChange={handleImageChange}
        />
      </div>

      <div className="pptx-toolbar-separator" />

      {/* Zoom */}
      <div className="pptx-toolbar-group">
        <button className="pptx-toolbar-btn" onClick={onZoomOut} title="Zoom Out">
          <Minus size={16} />
        </button>
        <button className="pptx-toolbar-btn" onClick={onZoomIn} title="Zoom In">
          <Plus size={16} />
        </button>
      </div>

      <div className="pptx-toolbar-separator" />

      {/* Presenter */}
      <div className="pptx-toolbar-group">
        <button className="pptx-toolbar-btn" onClick={onPresenterMode} title="Present (F5)">
          <Presentation size={16} />
        </button>
      </div>

      {/* Status */}
      {status && <span className="pptx-toolbar-status">{status}</span>}
    </div>
  );
}
