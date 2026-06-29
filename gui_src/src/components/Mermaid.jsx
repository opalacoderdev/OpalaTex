import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

// Initialize mermaid configuration once
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
});

export default function Mermaid({ chart }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;
    const uniqueId = `mermaid-${Math.floor(Math.random() * 1000000)}`;

    const renderChart = async () => {
      try {
        setError(null);
        // Clean up the input syntax
        const cleanChart = chart.trim();
        const { svg: renderedSvg } = await mermaid.render(uniqueId, cleanChart);
        if (isMounted) {
          setSvg(renderedSvg);
        }
      } catch (err) {
        console.error('Mermaid rendering error:', err);
        if (isMounted) {
          setError(err.message || 'Error rendering Mermaid chart');
        }
      }
    };

    renderChart();

    return () => {
      isMounted = false;
    };
  }, [chart]);

  if (error) {
    return (
      <pre style={{
        color: '#f48771',
        background: '#252526',
        padding: '10px',
        fontSize: '11px',
        fontFamily: 'monospace',
        overflowX: 'auto',
        borderRadius: '4px',
        border: '1px solid #3c3c3c'
      }}>
        {error}
      </pre>
    );
  }

  if (!svg) {
    return (
      <div style={{
        color: 'var(--vscode-descriptionForeground, #888)',
        fontSize: '12px',
        padding: '8px'
      }}>
        Generating diagram...
      </div>
    );
  }

  return (
    <div 
      dangerouslySetInnerHTML={{ __html: svg }} 
      style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        margin: '12px 0',
        padding: '10px',
        background: 'var(--editor-bg, #1e1e1e)',
        borderRadius: '4px',
        border: '1px solid var(--border-color, #3c3c3c)',
        overflowX: 'auto'
      }} 
    />
  );
}
