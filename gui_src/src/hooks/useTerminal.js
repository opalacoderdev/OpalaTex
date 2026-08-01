import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const LIGHT_TERMINAL_THEME = {
  background: '#ffffff',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  black: '#000000',
  red: '#a1260d',
  green: '#008000',
  yellow: '#795e00',
  blue: '#0451a5',
  magenta: '#811f7c',
  cyan: '#007acc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#a1260d',
  brightGreen: '#098658',
  brightYellow: '#795e00',
  brightBlue: '#0451a5',
  brightMagenta: '#811f7c',
  brightCyan: '#007acc',
  brightWhite: '#1e1e1e'
};

const DARK_TERMINAL_THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
};

// Hook that initialises an xterm.js terminal and connects it to the backend SSE stream.
export function useTerminal({ activeProject, terminalRef, terminalInstanceRef, fitAddonRef, eventSourceRef, activeBottomTab, bottomPanelHeight, isTerminalCollapsed, theme, termId = 'main', isActive = true }) {
  const promptDrawnRef = useRef(false);
  // Written on every render so the ResizeObserver callback (a closure created
  // once at mount) always reads the latest value without a stale-closure race.
  const isCollapsedRef = useRef(isTerminalCollapsed);
  isCollapsedRef.current = isTerminalCollapsed;
  const lastSizeRef = useRef({ cols: 0, rows: 0 });

  // Update terminal theme dynamically when theme changes
  useEffect(() => {
    if (terminalInstanceRef.current) {
      const isLight = theme === 'light';
      terminalInstanceRef.current.options.theme = isLight ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
    }
  }, [theme, terminalInstanceRef]);

  // Initialise / tear-down terminal when the active project changes.
  useEffect(() => {
    if (!activeProject) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    if (!terminalRef.current) return;

    // Reset the prompt-drawn flag whenever the terminal is (re)created.
    promptDrawnRef.current = false;

    const isLight = document.body.classList.contains('light-theme');
    const termTheme = isLight ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: termTheme,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    terminalRef.current.innerHTML = '';
    term.open(terminalRef.current);
    try { fitAddon.fit(); } catch (e) { /* ignore */ }

    terminalInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    // Connect to SSE terminal stream.
    const projectPath = activeProject.project_path;
    const url = `/api/terminal/stream?term_id=${termId}&projectPath=${encodeURIComponent(projectPath)}`;
    const evs = new EventSource(url);
    eventSourceRef.current = evs;

    evs.onmessage = (event) => {
      try {
        const raw = atob(event.data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        term.write(bytes);
      } catch (err) {
        console.error('Error decoding terminal stream data', err);
      }
    };

    evs.onerror = () => {
      term.write('\r\n\x1b[31m[OpalaTex] Conexão com o terminal perdida. Reconectando...\x1b[0m\r\n');
    };

    // Forward keystrokes to the backend.
    term.onData((data) => {
      fetch('/api/terminal/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term_id: termId, action: 'input', text: data, projectPath: activeProject.project_path }),
      }).catch(err => console.error('Failed to send terminal input', err));
    });

    let resizeTimeout;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) return;
      resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        if (fitAddon && !isCollapsedRef.current && isActive && terminalRef.current) {
          try {
            if (terminalRef.current.clientWidth === 0 || terminalRef.current.clientHeight === 0) return;
            fitAddon.fit();
            const { cols, rows } = term;
            if (cols > 0 && rows > 0 && (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows)) {
              lastSizeRef.current = { cols, rows };
              fetch('/api/terminal/input', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ term_id: termId, action: 'resize', cols, rows, projectPath: activeProject.project_path }),
              }).catch(err => console.error('Failed to send terminal resize', err));
            }
          } catch (e) { /* ignore */ }
        }
      }, 100); // 100ms debounce
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      if (evs) evs.close();
      term.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, [activeProject]);

  // Re-fit the terminal when the terminal tab becomes visible, the panel is expanded, or resized.
  useEffect(() => {
    if (activeBottomTab === 'terminal' && !isTerminalCollapsed && terminalInstanceRef.current && fitAddonRef.current && activeProject && isActive) {
      setTimeout(() => {
        try {
          if (terminalRef.current && (terminalRef.current.clientWidth === 0 || terminalRef.current.clientHeight === 0)) return;
          fitAddonRef.current.fit();
          const { cols, rows } = terminalInstanceRef.current;
          if (cols > 0 && rows > 0 && (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows)) {
            lastSizeRef.current = { cols, rows };
            fetch('/api/terminal/input', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ term_id: termId, action: 'resize', cols, rows, projectPath: activeProject.project_path }),
            }).catch(err => console.error('Failed to send terminal resize', err));
          }

          terminalInstanceRef.current.focus();

          // On the first time the terminal becomes visible, the shell may not have
          // redrawn its prompt after the initial resize (the tab was hidden during
          // creation so xterm.js had no valid dimensions). Sending Enter (\r) forces
          // the shell (especially PowerShell on Windows) to print a fresh, clean prompt.
          if (!promptDrawnRef.current) {
            promptDrawnRef.current = true;
              fetch('/api/terminal/input', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ term_id: termId, action: 'input', text: '\r', projectPath: activeProject.project_path }),
            }).catch(err => console.error('Failed to send prompt redraw', err));
          }
        } catch (e) { /* ignore */ }
      }, 50);
    }
  }, [activeBottomTab, bottomPanelHeight, activeProject, isTerminalCollapsed, isActive]);
}
