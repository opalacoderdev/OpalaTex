import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const PdfPreview = forwardRef(({ base64Pdf, directUrl, isCompiling, errorLog, activeProject, selectedFile, onSyncTexNavigate }, ref) => {
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
    if (directUrl) {
      setPdfUrl(directUrl);
    } else if (base64Pdf) {
      setPdfUrl(`/api/latex/pdf?ts=${Date.now()}`);
    } else {
      setPdfUrl('');
    }
  }, [base64Pdf, directUrl]);

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

  if (errorLog && !base64Pdf && !directUrl) {
    const parseErrors = (log) => {
      if (!log) return [];
      const lines = log.split('\n');
      const errors = [];
      for (const line of lines) {
        const lowerLine = line.toLowerCase();
        if (lowerLine.includes('error') || lowerLine.startsWith('!')) {
          if (
            lowerLine.includes('fontconfig error') || 
            lowerLine.includes('halted on potentially-recoverable error') ||
            lowerLine.includes('pdf file was not generated')
          ) {
            continue;
          }
          errors.push(line.trim());
        }
      }
      
      // Remove duplicates
      const uniqueErrors = [...new Set(errors)];
      
      if (uniqueErrors.length === 0 && log.trim().length > 0) {
        uniqueErrors.push("An error occurred during compilation. Please check the full log below.");
      }
      return uniqueErrors;
    };

    const displayErrors = parseErrors(errorLog);

    return (
      <div className="h-full w-full bg-slate-900 p-8 flex flex-col items-center justify-center overflow-y-auto">
        <div className="max-w-3xl w-full bg-slate-800 rounded-xl shadow-2xl overflow-hidden border border-red-500/30">
          <div className="bg-red-500/10 border-b border-red-500/20 p-6 flex items-center gap-4">
            <div className="bg-red-500/20 p-3 rounded-full shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-400">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-semibold text-red-400">Oops! We couldn't compile your document</h2>
              <p className="text-slate-400 text-sm mt-1">We found some issues in your LaTeX code that need to be fixed.</p>
            </div>
          </div>
          
          <div className="p-6">
            <h3 className="text-xs font-semibold text-slate-400 mb-4 uppercase tracking-wider">Main Issues</h3>
            <ul className="space-y-3 mb-6">
              {displayErrors.map((err, i) => (
                <li key={i} className="flex items-start gap-3 bg-red-500/5 p-4 rounded-lg border border-red-500/10">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-400 mt-0.5 shrink-0">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                    <line x1="12" y1="9" x2="12" y2="13"></line>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                  <span className="text-red-200 text-sm font-mono break-words leading-relaxed">{err}</span>
                </li>
              ))}
            </ul>
            
            <details className="group">
              <summary className="cursor-pointer text-sm text-slate-400 hover:text-slate-300 transition-colors flex items-center gap-2 select-none font-medium w-fit">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-90">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
                View Technical Details (Full Log)
              </summary>
              <div className="mt-4 bg-[#0a0f1c] p-4 rounded-lg overflow-x-auto border border-slate-700 shadow-inner max-h-64 overflow-y-auto">
                <pre className="text-[13px] text-slate-400 font-mono whitespace-pre-wrap">{errorLog}</pre>
              </div>
            </details>
          </div>
        </div>
      </div>
    );
  }

  if (!base64Pdf && !directUrl) {
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
