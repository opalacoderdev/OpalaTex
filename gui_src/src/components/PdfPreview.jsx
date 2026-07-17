import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useTranslation } from 'react-i18next';
import { Download, PanelRightClose, ZoomIn, ZoomOut, RotateCcw, ChevronUp, ChevronDown, Search, X } from 'lucide-react';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const PdfPreview = forwardRef(({ base64Pdf, sourceUrl, directUrl, isCompiling, errorLog, activeProject, selectedFile, onSyncTexNavigate, onCollapse, onDocumentReady }, ref) => {
  const { t } = useTranslation();
  const [numPages, setNumPages] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [highlight, setHighlight] = useState(null);
  const [scale, setScale] = useState(1.2);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [pdfTextPages, setPdfTextPages] = useState([]);
  const containerRef = useRef(null);
  const scrollPosRef = useRef(0);
  const restoreScrollPosRef = useRef(0);
  const isReloadingPdfRef = useRef(false);
  const pageNavRef = useRef(null);
  const searchInputRef = useRef(null);
  const pdfDocumentRef = useRef(null);

  const searchNeedle = searchQuery.trim().toLowerCase();

  const countMatches = (text, needle) => {
    if (!text || !needle) return 0;
    let count = 0;
    let index = text.toLowerCase().indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = text.toLowerCase().indexOf(needle, index + needle.length);
    }
    return count;
  };

  const handleScroll = () => {
    if (isReloadingPdfRef.current) return;
    if (containerRef.current) {
      scrollPosRef.current = containerRef.current.scrollTop;
    }
  };

  const handleZoomIn = () => {
    setScale(prev => Math.min(prev + 0.2, 3.0));
  };

  const handleZoomOut = () => {
    setScale(prev => Math.max(prev - 0.2, 0.6));
  };

  const handleResetZoom = () => {
    setScale(1.2);
  };

  const focusSearchInput = () => {
    setTimeout(() => {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      }
    }, 0);
  };

  const handleSearchToggle = () => {
    setIsSearchOpen((prev) => {
      const next = !prev;
      if (next) focusSearchInput();
      if (!next) clearSearch(false);
      return next;
    });
  };

  const clearSearch = (shouldFocus = true) => {
    setSearchQuery('');
    setSearchResults([]);
    setActiveSearchIndex(-1);
    if (shouldFocus) focusSearchInput();
  };

  const goToSearchResult = (index) => {
    if (!searchResults.length) return;
    const nextIndex = ((index % searchResults.length) + searchResults.length) % searchResults.length;
    setActiveSearchIndex(nextIndex);
    scrollToPage(searchResults[nextIndex].page);
  };

  const handleSearchSubmit = () => {
    if (!searchResults.length) return;
    goToSearchResult(activeSearchIndex >= 0 ? activeSearchIndex : 0);
  };

  const handleSearchPrev = () => {
    goToSearchResult((activeSearchIndex >= 0 ? activeSearchIndex : 0) - 1);
  };

  const handleSearchNext = () => {
    goToSearchResult((activeSearchIndex >= 0 ? activeSearchIndex : -1) + 1);
  };

  const renderSearchHighlights = (text) => {
    if (!searchNeedle || !text) return text;

    const lowerText = text.toLowerCase();
    const parts = [];
    let cursor = 0;
    let matchIndex = lowerText.indexOf(searchNeedle);

    while (matchIndex !== -1) {
      if (matchIndex > cursor) {
        parts.push(text.slice(cursor, matchIndex));
      }
      const matchText = text.slice(matchIndex, matchIndex + searchNeedle.length);
      parts.push(
        <mark
          key={`${matchIndex}-${parts.length}`}
          style={{
            backgroundColor: '#facc15',
            boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.9)',
            borderRadius: '2px',
            color: 'transparent',
            padding: '0 1px',
            WebkitBoxDecorationBreak: 'clone',
            boxDecorationBreak: 'clone',
          }}
        >
          {matchText}
        </mark>
      );
      cursor = matchIndex + searchNeedle.length;
      matchIndex = lowerText.indexOf(searchNeedle, cursor);
    }

    if (cursor < text.length) {
      parts.push(text.slice(cursor));
    }

    return parts;
  };

  // ── Page navigation ────────────────────────────────────────────────────
  // Scroll the PDF container so the requested page is centered in view.
  // Uses the same [data-page-number] selector as the forward-search
  // highlight logic. Retries a few times in case the page element has not
  // been rendered yet by react-pdf.
  const scrollToPage = (pageNum, attempt = 0) => {
    if (!containerRef.current || !numPages) return;
    const target = Math.max(1, Math.min(pageNum, numPages));
    const pageEl = containerRef.current.querySelector(`[data-page-number="${target}"]`);
    if (!pageEl && attempt < 10) {
      setTimeout(() => scrollToPage(target, attempt + 1), 120);
      return;
    }
    if (pageEl) {
      const offset = pageEl.offsetTop - containerRef.current.clientHeight / 2 + pageEl.clientHeight / 2;
      containerRef.current.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      setCurrentPage(target);
    }
  };

  const handlePageNavSubmit = () => {
    const n = parseInt(pageInput, 10);
    if (!isNaN(n)) {
      scrollToPage(n);
    }
    setPageInput('');
  };

  const handlePageNavPrev = () => {
    scrollToPage(currentPage - 1);
  };

  const handlePageNavNext = () => {
    scrollToPage(currentPage + 1);
  };

  // Track which page is currently in view using IntersectionObserver so the
  // page indicator stays in sync when the user scrolls manually.
  useEffect(() => {
    if (!containerRef.current || !numPages) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry closest to the top of the viewport.
        let best = null;
        let bestTop = Infinity;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const top = Math.abs(entry.boundingClientRect.top);
            if (top < bestTop) {
              bestTop = top;
              best = entry.target;
            }
          }
        }
        if (best) {
          const pn = parseInt(best.getAttribute('data-page-number'), 10);
          if (!isNaN(pn)) setCurrentPage(pn);
        }
      },
      { root: containerRef.current, threshold: 0.1 },
    );
    const pageEls = containerRef.current.querySelectorAll('[data-page-number]');
    pageEls.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [numPages, scale]);

  useEffect(() => {
    let cancelled = false;

    const loadPageText = async () => {
      const pdfDocument = pdfDocumentRef.current;
      if (!pdfDocument || !numPages || (!isSearchOpen && !searchNeedle)) {
        setPdfTextPages([]);
        return;
      }

      try {
        const pages = [];
        for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
          const page = await pdfDocument.getPage(pageNumber);
          const textContent = await page.getTextContent();
          pages.push(textContent.items.map((item) => item.str || '').join(' '));
        }
        if (!cancelled) {
          setPdfTextPages(pages);
        }
      } catch (err) {
        console.error('PDF text extraction failed:', err);
        if (!cancelled) {
          setPdfTextPages([]);
        }
      }
    };

    loadPageText();

    return () => {
      cancelled = true;
    };
  }, [numPages, pdfUrl, isSearchOpen, searchNeedle]);

  useEffect(() => {
    if (!searchNeedle || !pdfTextPages.length) {
      setSearchResults([]);
      setActiveSearchIndex(-1);
      return;
    }

    const results = [];
    pdfTextPages.forEach((pageText, pageIndex) => {
      const matches = countMatches(pageText, searchNeedle);
      for (let i = 0; i < matches; i += 1) {
        results.push({ page: pageIndex + 1 });
      }
    });

    setSearchResults(results);
    setActiveSearchIndex(results.length ? 0 : -1);
  }, [searchNeedle, pdfTextPages]);

  const handleSavePdf = () => {
    if (!pdfUrl) return;

    const selectedName = selectedFile?.replace(/\\/g, '/').split('/').pop() || 'document.pdf';
    const downloadName = selectedName.toLowerCase().endsWith('.pdf')
      ? selectedName
      : selectedName.replace(/\.[^.]*$/, '') + '.pdf';

    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  useEffect(() => {
    if (containerRef.current) {
      restoreScrollPosRef.current = containerRef.current.scrollTop;
      scrollPosRef.current = containerRef.current.scrollTop;
    }
    isReloadingPdfRef.current = true;

    if (directUrl) {
      setPdfUrl(directUrl);
    } else if (sourceUrl) {
      setPdfUrl(sourceUrl);
    } else if (base64Pdf) {
      setPdfUrl(`/api/latex/pdf?ts=${Date.now()}`);
    } else {
      setPdfUrl('');
      isReloadingPdfRef.current = false;
    }
    setPdfTextPages([]);
    setSearchResults([]);
    setActiveSearchIndex(-1);
    pdfDocumentRef.current = null;
  }, [base64Pdf, sourceUrl, directUrl]);

  function onDocumentLoadSuccess(pdfDocument) {
    pdfDocumentRef.current = pdfDocument;
    setNumPages(pdfDocument.numPages);
    setCurrentPage(1);
    setTimeout(() => {
      if (containerRef.current) {
        const nextScrollTop = restoreScrollPosRef.current || scrollPosRef.current;
        containerRef.current.scrollTop = nextScrollTop;
        scrollPosRef.current = nextScrollTop;
      }
      isReloadingPdfRef.current = false;
      if (onDocumentReady) onDocumentReady();
    }, 150);
  }
  
  const scrollToPosition = (page, x, y, w, h, attempt = 0) => {
      if (!containerRef.current) return;
      const pageEl = containerRef.current.querySelector(`[data-page-number="${page}"]`);
      if (!pageEl && attempt < 10) {
        setTimeout(() => {
          scrollToPosition(page, x, y, w, h, attempt + 1);
        }, 120);
        return;
      }
      if (pageEl) {
        const targetX = x * scale;
        const targetY = y * scale;
        const targetW = (w || 10) * scale;
        const targetH = (h || 14) * scale;
        
        // y from the backend is already the TOP of the bounding box (min_y - 10).
        // No need to subtract height.
        const top = targetY;
        
        setHighlight({ page, y: top, h: targetH });
        
        containerRef.current.scrollTo({
          top: Math.max(0, pageEl.offsetTop + top - 150), // offset a bit to show context
          behavior: 'smooth'
        });
        
        // Remove highlight after 2.5 seconds
        setTimeout(() => {
          setHighlight(null);
        }, 2500);
      }
  };

  // Expose scroll method to parent for Forward Search (Editor -> PDF)
   useImperativeHandle(ref, () => ({
    scrollTo: scrollToPosition
  }));

  const handlePageDoubleClick = async (e, pageIndex) => {
    if (!e.ctrlKey && !e.metaKey) return;
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
        // Use relFile (relative to project) for navigation; fall back to absolute file
        const navFile = data.result.relFile || data.result.file;
        onSyncTexNavigate(data.result.line, navFile);
      }
    } catch (err) {
      console.error("SyncTeX inverse search failed:", err);
    }
  };

  // A fresh compile error must always take precedence over a cached PDF URL.
  // Otherwise an old successful preview masks the current failure.
  if (errorLog && !directUrl) {
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
        uniqueErrors.push(t('pdfPreview.genericCompileError'));
      }
      return uniqueErrors;
    };

    const displayErrors = parseErrors(errorLog);

    return (
      <div className="h-full w-full p-8 flex flex-col items-center justify-center overflow-y-auto" style={{ background: 'var(--vscode-editor-bg)', color: 'var(--vscode-text-fg)' }}>
        <div className="max-w-3xl w-full rounded-xl shadow-2xl overflow-hidden border border-red-500/30" style={{ background: 'var(--vscode-sidebar-bg)' }}>
          <div className="border-b p-6 flex items-center gap-4" style={{ background: 'var(--vscode-errorBackground)', borderColor: 'color-mix(in srgb, var(--vscode-errorForeground) 25%, transparent)' }}>
            <div className="p-3 rounded-full shrink-0" style={{ background: 'var(--vscode-errorBackground)' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--vscode-errorForeground)' }}>
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--vscode-errorForeground)' }}>{t('pdfPreview.compileErrorTitle')}</h2>
              <p className="text-sm mt-1" style={{ color: 'var(--vscode-descriptionForeground, #888)' }}>{t('pdfPreview.compileErrorDescription')}</p>
            </div>
          </div>
          
          <div className="p-6">
            <h3 className="text-xs font-semibold mb-4 uppercase tracking-wider" style={{ color: 'var(--vscode-descriptionForeground, #888)' }}>{t('pdfPreview.mainIssues')}</h3>
            <ul className="space-y-3 mb-6">
              {displayErrors.map((err, i) => (
                <li key={i} className="flex items-start gap-3 p-4 rounded-lg border" style={{ background: 'var(--vscode-errorBackground)', borderColor: 'color-mix(in srgb, var(--vscode-errorForeground) 18%, transparent)' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" style={{ color: 'var(--vscode-errorForeground)' }}>
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                    <line x1="12" y1="9" x2="12" y2="13"></line>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                  <span className="text-sm font-mono break-words leading-relaxed" style={{ color: 'var(--vscode-text-fg)' }}>{err}</span>
                </li>
              ))}
            </ul>
            
            <details className="group">
              <summary className="cursor-pointer text-sm transition-colors flex items-center gap-2 select-none font-medium w-fit" style={{ color: 'var(--vscode-descriptionForeground, #888)' }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-90">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
                {t('pdfPreview.technicalDetails')}
              </summary>
              <div className="mt-4 p-4 rounded-lg overflow-x-auto border shadow-inner max-h-64 overflow-y-auto" style={{ background: 'var(--vscode-bg)', borderColor: 'var(--vscode-border)' }}>
                <pre className="text-[13px] font-mono whitespace-pre-wrap" style={{ color: 'var(--vscode-text-fg)' }}>{errorLog}</pre>
              </div>
            </details>
          </div>
        </div>
      </div>
    );
  }

  if (!base64Pdf && !sourceUrl && !directUrl) {
    return (
      <div className="flex items-center justify-center h-full w-full" style={{ background: 'var(--vscode-editor-bg)', color: 'var(--vscode-descriptionForeground, #888)' }}>
        <p>{t('pdfPreview.noDocument')}</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden" style={{ background: 'var(--vscode-editor-bg)' }}>
      {isCompiling && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: 'var(--vscode-editorOverlay)' }}>
          <div className="flex flex-col items-center gap-4 p-6 rounded-lg shadow-xl" style={{ background: 'var(--vscode-sidebar-bg)', color: 'var(--vscode-text-fg)' }}>
            <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--vscode-active-border)' }}></div>
            <p>{t('pdfPreview.compiling')}</p>
          </div>
        </div>
      )}
      
      {/* PDF Controls */}
      <div 
        className="absolute top-4 right-4 z-50 flex items-center gap-1.5 rounded-lg shadow-lg p-1.5"
        style={{
          background: 'var(--vscode-sidebar-bg)',
          border: '1px solid var(--vscode-border)',
        }}
      >
        <button
          onClick={handleSavePdf}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: 'var(--vscode-text-fg)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('editorPanel.savePdf')}
        >
          <Download size={18} />
        </button>
        <button
          onClick={handleSearchToggle}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: isSearchOpen ? 'var(--vscode-button-bg)' : 'var(--vscode-input-bg)',
            border: `1px solid ${isSearchOpen ? 'var(--vscode-button-bg)' : 'var(--vscode-border)'}`,
            color: isSearchOpen ? '#ffffff' : 'var(--vscode-text-fg)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = isSearchOpen ? 'var(--vscode-button-bg)' : 'var(--vscode-input-bg)'; e.currentTarget.style.color = isSearchOpen ? '#ffffff' : 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = isSearchOpen ? 'var(--vscode-button-bg)' : 'var(--vscode-border)'; }}
          title={t('pdfPreview.searchPdf')}
        >
          <Search size={18} />
        </button>
        {isSearchOpen && (
          <div
            className="flex items-center rounded-md"
            style={{
              background: 'var(--vscode-input-bg)',
              border: '1px solid var(--vscode-border)',
              height: '32px',
              maxWidth: '260px',
            }}
          >
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.shiftKey) handleSearchPrev();
                else if (e.key === 'Enter') handleSearchSubmit();
                else if (e.key === 'Escape') clearSearch();
              }}
              placeholder={t('pdfPreview.searchPlaceholder')}
              style={{
                width: '118px',
                height: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--vscode-text-fg)',
                fontSize: '12px',
                padding: '0 8px',
              }}
            />
            <span
              className="text-xs flex items-center px-1.5"
              style={{
                color: 'var(--vscode-descriptionForeground)',
                fontSize: '11px',
                whiteSpace: 'nowrap',
                borderLeft: '1px solid var(--vscode-border)',
                height: '100%',
              }}
            >
              {searchResults.length
                ? `${activeSearchIndex + 1}/${searchResults.length}`
                : searchNeedle
                  ? t('pdfPreview.noSearchResults')
                  : '0/0'}
            </span>
            <button
              type="button"
              onClick={handleSearchPrev}
              disabled={!searchResults.length}
              className="flex items-center justify-center transition-colors"
              style={{
                width: '28px',
                height: '100%',
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                borderLeft: '1px solid var(--vscode-border)',
                color: searchResults.length ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)',
                cursor: searchResults.length ? 'pointer' : 'default',
                opacity: searchResults.length ? 1 : 0.5,
                padding: 0,
              }}
              title={t('pdfPreview.previousMatch')}
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              onClick={handleSearchNext}
              disabled={!searchResults.length}
              className="flex items-center justify-center transition-colors"
              style={{
                width: '28px',
                height: '100%',
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                borderLeft: '1px solid var(--vscode-border)',
                color: searchResults.length ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)',
                cursor: searchResults.length ? 'pointer' : 'default',
                opacity: searchResults.length ? 1 : 0.5,
                padding: 0,
              }}
              title={t('pdfPreview.nextMatch')}
            >
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              onClick={clearSearch}
              className="flex items-center justify-center transition-colors"
              style={{
                width: '28px',
                height: '100%',
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                borderLeft: '1px solid var(--vscode-border)',
                color: 'var(--vscode-text-fg)',
                cursor: 'pointer',
                padding: 0,
              }}
              title={t('pdfPreview.clearSearch')}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="flex items-center justify-center rounded-md transition-colors"
            style={{
              width: '32px',
              height: '32px',
              background: 'var(--vscode-input-bg)',
              border: '1px solid var(--vscode-border)',
              color: 'var(--vscode-text-fg)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
            title={t('editorPanel.collapsePdfPreview')}
          >
            <PanelRightClose size={18} />
          </button>
        )}
        <button
          onClick={handleZoomOut}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: 'var(--vscode-text-fg)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('editorPanel.zoomOut')}
        >
          <ZoomOut size={18} />
        </button>
        <span 
          className="text-xs font-semibold text-center rounded-md"
          style={{
            minWidth: '52px',
            padding: '6px 8px',
            background: 'var(--vscode-input-bg)',
            color: 'var(--vscode-text-fg)',
            border: '1px solid var(--vscode-border)',
          }}
        >
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={handleZoomIn}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: 'var(--vscode-text-fg)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('editorPanel.zoomIn')}
        >
          <ZoomIn size={18} />
        </button>
        {scale !== 1.2 && (
          <button
            onClick={handleResetZoom}
            className="flex items-center justify-center rounded-md transition-colors"
            style={{
              width: '32px',
              height: '32px',
              background: 'var(--vscode-input-bg)',
              border: '1px solid var(--vscode-border)',
              color: 'var(--vscode-text-fg)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
            title={t('editorPanel.resetZoom')}
          >
            <RotateCcw size={18} />
          </button>
        )}
        {/* Page navigation: prev / [input] of N / next */}
        {numPages && numPages > 1 && (
          <>
            <div style={{ width: '1px', height: '24px', background: 'var(--vscode-border)', margin: '0 2px' }} />
            <button
              onClick={handlePageNavPrev}
              disabled={currentPage <= 1}
              className="flex items-center justify-center rounded-md transition-colors"
              style={{
                width: '32px',
                height: '32px',
                background: 'var(--vscode-input-bg)',
                border: '1px solid var(--vscode-border)',
                color: currentPage <= 1 ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-text-fg)',
                opacity: currentPage <= 1 ? 0.5 : 1,
                cursor: currentPage <= 1 ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => { if (currentPage > 1) { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
              title={t('editorPanel.prevPage')}
            >
              <ChevronUp size={18} />
            </button>
            <div
              ref={pageNavRef}
              className="flex items-center rounded-md"
              style={{
                background: 'var(--vscode-input-bg)',
                border: '1px solid var(--vscode-border)',
                height: '32px',
              }}
              title={t('editorPanel.goToPage')}
            >
              <input
                type="text"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePageNavSubmit(); }}
                onFocus={(e) => e.target.select()}
                placeholder={String(currentPage)}
                className="text-center"
                style={{
                  width: '32px',
                  height: '100%',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--vscode-text-fg)',
                  fontSize: '12px',
                }}
              />
              <span
                className="text-xs flex items-center px-1.5"
                style={{
                  color: 'var(--vscode-descriptionForeground)',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  borderLeft: '1px solid var(--vscode-border)',
                  height: '100%',
                }}
              >
                / {numPages}
              </span>
            </div>
            <button
              onClick={handlePageNavNext}
              disabled={currentPage >= numPages}
              className="flex items-center justify-center rounded-md transition-colors"
              style={{
                width: '32px',
                height: '32px',
                background: 'var(--vscode-input-bg)',
                border: '1px solid var(--vscode-border)',
                color: currentPage >= numPages ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-text-fg)',
                opacity: currentPage >= numPages ? 0.5 : 1,
                cursor: currentPage >= numPages ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => { if (currentPage < numPages) { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
              title={t('editorPanel.nextPage')}
            >
              <ChevronDown size={18} />
            </button>
          </>
        )}
      </div>
      
      <div 
        className="w-full h-full overflow-y-auto flex flex-col items-center py-8"
        ref={containerRef}
        onScroll={handleScroll}
        style={{ background: 'var(--vscode-editor-bg)' }}
      >
        {pdfUrl && (
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={<div style={{ color: 'var(--vscode-text-fg)' }}>{t('pdfPreview.loadingPdf')}</div>}
            error={<div style={{ color: 'var(--vscode-errorForeground)' }}>{t('pdfPreview.loadError')}</div>}
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
                  customTextRenderer={({ str }) => renderSearchHighlights(str)}
                  scale={scale}
                />
                
                {/* Visual Highlight for Forward Search */}
                {highlight && highlight.page === index + 1 && (
                  <div 
                    style={{
                      position: 'absolute',
                      zIndex: 99999,
                      left: 0,
                      top: `${highlight.y * (scale / 1.2)}px`, 
                      width: '100%',
                      height: `${Math.max(highlight.h * (scale / 1.2), 18)}px`,
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
