import React, { useState, useRef, useEffect } from 'react';
import { Plus, Settings, Trash2, RefreshCw, ExternalLink, FolderOpen, ChevronDown, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import FileNode from './FileNode';

// Left sidebar — Explorer tab: project list + workspace file tree.
export default function ExplorerSidebar({
  projects,
  activeProject,
  handleSelectProject,
  onNewProject,
  onImportProject,
  importError,
  onClearImportError,
  files,
  selectedFile,
  selectedNodes,
  handleNodeSelect,
  fileContents,
  originalFileContents,
  handleFileSelect,
  handleNodeContextMenu,
  handleWorkspaceContextMenu,
  draggedNode,
  setDraggedNode,
  dragOverPath,
  setDragOverPath,
  handleMoveNode,
  fetchFiles,
  showHiddenWorkspaceFiles,
  onShowHiddenWorkspaceFilesChange,
  openEditModal,
  handleDeleteProject,
  renamingNodePath,
  setRenamingNodePath,
  executeRenameNode,
  cloudFileStates,
}) {
  const { t } = useTranslation();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="vscode-sidebar-header">
        <span className="vscode-sidebar-title">{t('explorerSidebar.header')}</span>
        <button
          onClick={onNewProject}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)' }}
          title={t('explorerSidebar.newProject')}
        >
          <Plus size={14} />
        </button>
        <button
          onClick={onImportProject}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)', marginLeft: '6px' }}
          title={t('explorerSidebar.importProject', 'Import Project')}
        >
          <FolderOpen size={14} />
        </button>
      </div>

      {/* Import error message */}
      {importError && (
        <div style={{ padding: '6px 10px', fontSize: '11px', color: '#f48771', background: 'var(--vscode-sidebar-bg)', borderBottom: '1px solid var(--vscode-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
          <span>⚠️ {importError}</span>
          <button onClick={() => onClearImportError && onClearImportError()} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#f48771', padding: '0', lineHeight: 1, flexShrink: 0 }}>✕</button>
        </div>
      )}

      {/* Projects list */}
      <div className="vscode-sidebar-section" style={{ borderBottom: '1px solid var(--vscode-border)', paddingBottom: '10px' }}>
        <div className="vscode-sidebar-section-title">{t('explorerSidebar.selectProject')}</div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', padding: '0 4px', position: 'relative' }} ref={dropdownRef}>
          {/* Main Dropdown Button */}
          <div style={{ flex: 1, position: 'relative' }}>
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="vscode-settings-input"
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                height: '26px',
                fontSize: '12px',
                cursor: 'pointer',
                textAlign: 'left',
                border: '1px solid var(--vscode-dropdown-border, var(--vscode-border, #3c3c3c))',
                background: 'var(--vscode-dropdown-background, var(--vscode-input-bg, #252526))',
                color: 'var(--vscode-dropdown-foreground, var(--vscode-input-fg, #cccccc))',
                borderRadius: '2px',
              }}
            >
              <span className="truncate" style={{ fontWeight: '500' }}>
                {activeProject ? (activeProject.project_name || activeProject.name) : t('explorerSidebar.selectProjectPlaceholder', 'Selecionar projeto...')}
              </span>
              <ChevronDown size={14} style={{ opacity: 0.7, flexShrink: 0, marginLeft: '4px' }} />
            </button>

            {isDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: '2px',
                  background: 'var(--vscode-dropdown-background, var(--vscode-sidebar-bg, #252526))',
                  border: '1px solid var(--vscode-dropdown-border, var(--vscode-border, #3c3c3c))',
                  borderRadius: '3px',
                  boxShadow: '0 4px 8px rgba(0, 0, 0, 0.3)',
                  zIndex: 100,
                  maxHeight: '200px',
                  overflowY: 'auto',
                }}
              >
                {projects.length === 0 ? (
                  <div style={{ padding: '6px 10px', fontSize: '11px', color: '#808080', fontStyle: 'italic' }}>
                    {t('explorerSidebar.noProjects', 'Nenhum projeto encontrado')}
                  </div>
                ) : (
                  projects.map(p => {
                    const isActive = activeProject && activeProject.name === p.name;
                    const isMissing = p.exists === false;
                    return (
                      <div
                        key={p.name}
                        onClick={(e) => {
                          if (isMissing) {
                            openEditModal(e, p);
                          } else {
                            handleSelectProject(p);
                          }
                          setIsDropdownOpen(false);
                        }}
                        title={isMissing ? t('explorerSidebar.projectPathMissingHint', 'Project folder not found on this machine. Click to fix its path.') : undefined}
                        style={{
                          padding: '6px 10px',
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '2px',
                          borderBottom: '1px solid rgba(255,255,255,0.03)',
                          background: isActive ? 'var(--vscode-list-activeSelectionBackground, var(--vscode-accent, #007acc))' : 'transparent',
                          color: isActive ? 'var(--vscode-list-activeSelectionForeground, #ffffff)' : 'var(--vscode-dropdown-foreground, var(--vscode-input-fg, #cccccc))',
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive) e.currentTarget.style.background = 'var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08))';
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        <div style={{ fontSize: '12px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '5px' }} className="truncate">
                          {isMissing && <AlertTriangle size={11} color="#e2c08d" style={{ flexShrink: 0 }} />}
                          {p.project_name || p.name}
                        </div>
                        <div style={{ fontSize: '11px', color: isMissing ? '#e2c08d' : (isActive ? 'rgba(255,255,255,0.7)' : '#808080') }} className="truncate">
                          {isMissing ? t('explorerSidebar.projectPathMissing', 'Not found: {{path}}', { path: p.project_path }) : p.project_path}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Action buttons for the active project */}
          {activeProject && (
            <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await fetch('/api/file/open-explorer', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ projectPath: activeProject.project_path })
                    });
                  } catch (err) {
                    console.error('Failed to open explorer:', err);
                  }
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#a0a0a0',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '3px',
                }}
                title={t('explorerSidebar.openFolder', 'Abrir pasta no Sistema Operacional')}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#ffffff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#a0a0a0'; }}
              >
                <ExternalLink size={14} />
              </button>
              <button
                onClick={(e) => openEditModal(e, activeProject)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#a0a0a0',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '3px',
                }}
                title={t('explorerSidebar.configureProject')}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#ffffff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#a0a0a0'; }}
              >
                <Settings size={14} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteProject(activeProject.name); }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#a0a0a0',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '3px',
                }}
                title={t('explorerSidebar.removeProject')}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#ffffff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#a0a0a0'; }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Workspace file tree */}
      <div
        className="vscode-sidebar-content"
        onContextMenu={handleWorkspaceContextMenu}
        onDragOver={(e) => {
          e.preventDefault();
          if (draggedNode) setDragOverPath('__root__');
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          if (dragOverPath === '__root__') setDragOverPath(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverPath(null);
          if (draggedNode) handleMoveNode(draggedNode.paths, '');
        }}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'F2' && selectedFile && !renamingNodePath && setRenamingNodePath) {
            e.preventDefault();
            setRenamingNodePath(selectedFile);
          }
        }}
        style={dragOverPath === '__root__' ? { border: '2px dashed #007acc', backgroundColor: 'rgba(0, 122, 204, 0.05)', outline: 'none' } : { outline: 'none' }}
      >
        <div className="vscode-sidebar-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('explorerSidebar.workspaceFiles')}</span>
          {activeProject && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <label
                title={t('explorerSidebar.showHiddenFilesTooltip')}
                style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--vscode-descriptionForeground)', fontSize: '11px', textTransform: 'none', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(showHiddenWorkspaceFiles)}
                  onChange={(e) => {
                    e.stopPropagation();
                    onShowHiddenWorkspaceFilesChange?.(e.target.checked);
                  }}
                  style={{ width: '12px', height: '12px', margin: 0 }}
                />
                <span>{t('explorerSidebar.showHiddenFiles')}</span>
              </label>
              <button
                onClick={(e) => { e.stopPropagation(); fetchFiles(); }}
                title={t('explorerSidebar.refreshFiles')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#808080',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '2px',
                  borderRadius: '3px',
                  transition: 'color 0.2s, background-color 0.2s',
                }}
                onMouseOver={(e) => { e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'; }}
                onMouseOut={(e) => { e.currentTarget.style.color = '#808080'; e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <RefreshCw size={12} />
              </button>
            </div>
          )}
        </div>

        {files.length === 0 ? (
          <div style={{ fontSize: '12px', color: '#808080', padding: '0 4px', fontStyle: 'italic' }}>
            {t('explorerSidebar.selectProjectToExplore')}
          </div>
        ) : (
          <div>
            {files.map(node => (
              <FileNode
                key={node.path}
                node={node}
                selectedFile={selectedFile}
                selectedNodes={selectedNodes}
                fileContents={fileContents}
                originalFileContents={originalFileContents}
                handleNodeSelect={handleNodeSelect}
                handleFileSelect={handleFileSelect}
                handleNodeContextMenu={handleNodeContextMenu}
                draggedNode={draggedNode}
                setDraggedNode={setDraggedNode}
                dragOverPath={dragOverPath}
                setDragOverPath={setDragOverPath}
                handleMoveNode={handleMoveNode}
                renamingNodePath={renamingNodePath}
                setRenamingNodePath={setRenamingNodePath}
                executeRenameNode={executeRenameNode}
                cloudFileStates={cloudFileStates}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
