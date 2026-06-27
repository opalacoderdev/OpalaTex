import React, { useState, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export default function PdfPreview({ base64Pdf, isCompiling, errorLog }) {
  const [numPages, setNumPages] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
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
              <div key={`page_${index + 1}`} className="shadow-2xl mb-8 bg-white">
                <Page
                  pageNumber={index + 1}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  scale={1.2}
                />
              </div>
            ))}
          </Document>
        )}
      </div>
    </div>
  );
}
