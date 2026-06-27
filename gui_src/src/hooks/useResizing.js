import { useCallback } from 'react';

// Hook that provides mouse-drag resizing for the sidebar, chat panel, and bottom panel.
export function useResizing({ setSidebarWidth, setChatWidth, setBottomPanelHeight, sidebarWidth, chatWidth, bottomPanelHeight }) {
  const startResizing = useCallback((mouseDownEvent, direction) => {
    mouseDownEvent.preventDefault();
    const startX = mouseDownEvent.clientX;
    const startY = mouseDownEvent.clientY;
    const startWidthLeft = sidebarWidth;
    const startWidthRight = chatWidth;
    const startHeightBottom = bottomPanelHeight;

    const handleMouseMove = (mouseMoveEvent) => {
      if (direction === 'left') {
        const deltaX = mouseMoveEvent.clientX - startX;
        const newWidth = Math.max(150, Math.min(600, startWidthLeft + deltaX));
        setSidebarWidth(newWidth);
      } else if (direction === 'right') {
        const deltaX = mouseMoveEvent.clientX - startX;
        const newWidth = Math.max(200, Math.min(600, startWidthRight - deltaX));
        setChatWidth(newWidth);
      } else if (direction === 'bottom') {
        const deltaY = mouseMoveEvent.clientY - startY;
        const newHeight = Math.max(100, Math.min(600, startHeightBottom - deltaY));
        setBottomPanelHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth, chatWidth, bottomPanelHeight, setSidebarWidth, setChatWidth, setBottomPanelHeight]);

  return { startResizing };
}
