import React, { useRef, useEffect } from 'react';
import { useTerminal } from '../hooks/useTerminal';

export default function TerminalInstance({
  termId,
  activeProject,
  activeBottomTab,
  bottomPanelHeight,
  isTerminalCollapsed,
  theme,
  isActive,
  onMount
}) {
  const terminalRef = useRef(null);
  const terminalInstanceRef = useRef(null);
  const fitAddonRef = useRef(null);
  const eventSourceRef = useRef(null);

  useTerminal({
    activeProject,
    terminalRef,
    terminalInstanceRef,
    fitAddonRef,
    eventSourceRef,
    activeBottomTab,
    bottomPanelHeight,
    isTerminalCollapsed,
    theme,
    termId,
    isActive
  });

  useEffect(() => {
    if (terminalInstanceRef.current && onMount) {
      onMount(terminalInstanceRef.current);
    }
  }, [terminalInstanceRef.current]);

  return (
    <div
      style={{
        display: isActive ? 'block' : 'none',
        width: '100%',
        height: '100%',
        padding: '4px'
      }}
    >
      <div ref={terminalRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
