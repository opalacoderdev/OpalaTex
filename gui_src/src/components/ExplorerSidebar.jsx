import React from 'react';
import { Plus, Settings, Trash2, RefreshCw, ExternalLink, FolderOpen } from 'lucide-react';
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
  openEditModal,
  handleDeleteProject,
}) {
  const { t } = useTranslation();

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
      <div className="vscode-sidebar-section">
        <div className="vscode-sidebar-section-title">{t('explorerSidebar.selectProject')}</div>
        <div className="overflow-y-auto" style={{ maxHeight: '140px' }}>
          {projects.map(p => {
            const isActive = activeProject && activeProject.name === p.name;
            return (
              <div
                key={p.name}
                onClick={() => handleSelectProject(p)}
                className={`vscode-project-item ${isActive ? 'active' : ''}`}
              >
                <div className="truncate flex-1">
                  <div style={{ fontSize: '13px', fontWeight: '500' }} className="truncate">
                    {p.project_name || p.name}
                  </div>
                  <div style={{ fontSize: '10px', color: '#808080' }} className="truncate">
                    {p.project_path}
                  </div>
                </div>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await fetch('/api/file/open-explorer', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectPath: p.project_path })
                      });
                    } catch (err) {
                      console.error('Failed to open explorer:', err);
                    }
                  }}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#a0a0a0', padding: '2px 4px' }}
                  title="Abrir pasta no Sistema Operacional"
                >
                  <ExternalLink size={12} />
                </button>
                <button
                  onClick={(e) => openEditModal(e, p)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#a0a0a0', padding: '2px 4px' }}
                  title={t('explorerSidebar.configureProject')}
                >
                  <Settings size={12} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.name); }}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#a0a0a0', padding: '2px 4px' }}
                  title={t('explorerSidebar.removeProject')}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
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
          if (draggedNode) handleMoveNode(draggedNode.path, '', draggedNode.isDirectory);
        }}
        style={dragOverPath === '__root__' ? { border: '2px dashed #007acc', backgroundColor: 'rgba(0, 122, 204, 0.05)' } : {}}
      >
        <div className="vscode-sidebar-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('explorerSidebar.workspaceFiles')}</span>
          {activeProject && (
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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
