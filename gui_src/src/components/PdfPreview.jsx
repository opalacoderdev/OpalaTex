import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const PdfPreview = forwardRef(({ base64Pdf, isCompiling, errorLog, activeProject, selectedFile, onSyncTexNavigate }, ref) => {
  const [numPages, setNumPages] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [highlight, setHighlight] = useState(null);
  const containerRef = useRef(null);
  const scrollPosRef = useRef(0);

  const handleScroll = () => {
    if (containerRef.current) {
      scrollPosRef.current = containerRef.current.scrollTop;
    }
  };

  useEffect(() => {
    if (base64Pdf) {
      setPdfUrl(`/api/latex/pdf?ts=${Date.now()}`);
    }
  }, [base64Pdf]);

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages);
    setTimeout(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = scrollPosRef.current;
      }
    }, 100);
  }
  
  // Expose scroll method to parent for Forward Search (Editor -> PDF)
   useImperativeHandle(ref, () => ({
    scrollTo: (page, x, y, w, h) => {
      if (!containerRef.current) return;
      const pageEl = containerRef.current.querySelector(`[data-page-number="${page}"]`);
      if (pageEl) {
        // scale is 1.2
        const targetX = x * 1.2;
        const targetY = y * 1.2;
        const targetW = (w || 10) * 1.2; // fallback width if 0
        const targetH = (h || 14) * 1.2; // fallback height if 0
        
        // y from the backend is already the TOP of the bounding box (min_y - 10).
        // No need to subtract height.
        const top = targetY;
        
        setHighlight({ page, y: top, h: targetH });
        console.log('Highlight CSS:', { page, targetY, top, targetH });
        
        containerRef.current.scrollTo({
          top: Math.max(0, pageEl.offsetTop + top - 150), // offset a bit to show context
          behavior: 'smooth'
        });
        
        // Remove highlight after 2.5 seconds
        setTimeout(() => {
          setHighlight(null);
        }, 2500);
      }
    }
  }));

  const handlePageDoubleClick = async (e, pageIndex) => {
    if (!activeProject?.project_path || !selectedFile) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    
    // Convert to PDF points based on scale 1.2
    const ptX = rawX / 1.2;
    const ptY = rawY / 1.2;
    
    try {
      const res = await fetch(`/api/latex/synctex?action=pdf2tex&page=${pageIndex}&x=${ptX}&y=${ptY}&filePath=${encodeURIComponent(selectedFile)}&projectPath=${encodeURIComponent(activeProject.project_path)}`);
      const data = await res.json();
      if (data.result && data.result.line && onSyncTexNavigate) {
        onSyncTexNavigate(data.result.line, data.result.file);
      }
    } catch (err) {
      console.error("SyncTeX inverse search failed:", err);
    }
  };

  if (errorLog && !base64Pdf) {
    return (
      <div className="h-full w-full bg-slate-950 p-6 overflow-y-auto">
        <div className="text-red-400 font-mono text-sm whitespace-pre-wrap">
          <h2 className="text-xl font-bold mb-4 text-red-500">Compilation Error</h2>
          {errorLog}
        </div>
      </div>
    );
  }

  if (!base64Pdf) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-slate-900 text-slate-500">
        <p>No document compiled yet. Write some LaTeX and compile!</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden bg-gray-500">
      {isCompiling && (
        <div className="absolute inset-0 z-10 bg-slate-900/60 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 bg-slate-800 p-6 rounded-lg shadow-xl text-white">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            <p>Compiling...</p>
          </div>
        </div>
      )}
      
      <div 
        className="w-full h-full overflow-y-auto flex flex-col items-center py-8"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {pdfUrl && (
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={<div className="text-white">Loading PDF...</div>}
            error={<div className="text-red-300">Failed to load PDF viewer.</div>}
          >
            {Array.from(new Array(numPages || 0), (el, index) => (
              <div 
                key={`page_${index + 1}`} 
                data-page-number={index + 1}
                className="shadow-2xl mb-8 bg-white cursor-text relative"
                onDoubleClick={(e) => handlePageDoubleClick(e, index + 1)}
              >
                <Page
                  pageNumber={index + 1}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  scale={1.2}
                />
                
                {/* Visual Highlight for Forward Search */}
                {highlight && highlight.page === index + 1 && (
                  <div 
                    style={{
                      position: 'absolute',
                      zIndex: 99999,
                      left: 0,
                      top: `${highlight.y}px`, 
                      width: '100%',
                      height: `${Math.max(highlight.h, 18)}px`,
                      backgroundColor: 'rgba(250, 204, 21, 0.25)',
                      borderLeft: '6px solid #ef4444',
                      pointerEvents: 'none',
                      boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
                      transition: 'opacity 0.3s ease-in'
                    }}
                  />
                )}
              </div>
            ))}
          </Document>
        )}
      </div>
    </div>
  );
});

export default PdfPreview;
