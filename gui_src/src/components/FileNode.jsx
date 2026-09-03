import React, { useState, useEffect, useRef } from 'react';
import { Folder, File, ChevronRight, ChevronDown } from 'lucide-react';
import CloudFileBadge from './CloudFileBadge';

// Recursive file/directory tree node with drag-and-drop & inline rename support.
export default function FileNode({
  node,
  selectedFile,
  selectedNodes,
  fileContents,
  originalFileContents,
  handleNodeSelect,
  handleFileSelect,
  handleNodeContextMenu,
  draggedNode,
  setDraggedNode,
  dragOverPath,
  setDragOverPath,
  handleMoveNode,
  renamingNodePath,
  setRenamingNodePath,
  executeRenameNode,
  cloudFileStates,
}) {
  const isDir = node.isDirectory;
  // The tree carries OS-separated relative paths; the sync state is keyed by
  // POSIX ones, which is the only place the two representations meet.
  const cloudState = cloudFileStates?.[String(node.path).replace(/\\/g, '/')];
  const [isOpen, setIsOpen] = useState(false);
  const isRenaming = renamingNodePath === node.path;
  const [editName, setEditName] = useState(node.name);
  const inputRef = useRef(null);

  useEffect(() => {
    if (isRenaming) {
      setEditName(node.name);
    }
  }, [isRenaming, node.name]);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      const dotIndex = node.name.lastIndexOf('.');
      if (!isDir && dotIndex > 0) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    }
  }, [isRenaming, isDir, node.name]);

  const handleRenameSubmit = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== node.name && executeRenameNode) {
      const lastSlash = Math.max(node.path.lastIndexOf('/'), node.path.lastIndexOf('\\'));
      const parentDir = lastSlash !== -1 ? node.path.substring(0, lastSlash + 1) : '';
      const newPath = parentDir + trimmed;
      executeRenameNode(node, newPath);
    } else {
      if (setRenamingNodePath) setRenamingNodePath(null);
    }
  };

  const handleKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (setRenamingNodePath) setRenamingNodePath(null);
    }
  };

  const handleDragStart = (e) => {
    e.stopPropagation();
    // Dragging a node that is part of the current multi-selection drags the whole selection.
    const paths = (selectedNodes && selectedNodes.has(node.path) && selectedNodes.size > 1)
      ? Array.from(selectedNodes)
      : [node.path];
    setDraggedNode({ paths });
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDir) return;
    if (draggedNode && !draggedNode.paths.includes(node.path)) {
      setDragOverPath(node.path);
      e.dataTransfer.dropEffect = 'move';
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragOverPath === node.path) {
      setDragOverPath(null);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    if (!isDir) return;
    if (draggedNode && !draggedNode.paths.includes(node.path)) {
      handleMoveNode(draggedNode.paths, node.path);
    }
  };

  const isDragOver = dragOverPath === node.path;
  let baseStyle = isDragOver ? { backgroundColor: 'var(--vscode-hover-item)', border: '1px dashed var(--vscode-accent)' } : {};

  // Check if node is part of the multi-selection
  const isMultiSelected = selectedNodes && selectedNodes.has(node.path);

  const isDirty = !isDir && originalFileContents && fileContents?.[node.path] !== originalFileContents[node.path] && originalFileContents[node.path] !== undefined;

  const renderRenameInput = () => (
    <input
      ref={inputRef}
      type="text"
      value={editName}
      onChange={(e) => setEditName(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleRenameSubmit}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        background: 'var(--vscode-input-bg, #1e1e1e)',
        color: 'var(--vscode-input-fg, var(--vscode-text-fg))',
        border: '1px solid var(--vscode-focusBorder, #007acc)',
        borderRadius: '2px',
        outline: 'none',
        fontSize: '12px',
        padding: '0 4px',
        lineHeight: '18px',
        height: '20px',
        width: '100%',
        boxSizing: 'border-box',
      }}
    />
  );

  if (isDir) {
    return (
      <div
        className="select-none"
        draggable={!isRenaming}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          onClick={(e) => {
            if (isRenaming) return;
            if (e.ctrlKey || e.metaKey) {
              handleNodeSelect(node.path, true, e);
            } else {
              setIsOpen(!isOpen);
              handleNodeSelect(node.path, true, e);
            }
          }}
          className={`vscode-tree-node ${isMultiSelected ? 'active' : ''}`}
          style={baseStyle}
          onContextMenu={(e) => handleNodeContextMenu(e, node)}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Folder size={14} className="text-white" style={{ color: 'var(--vscode-fg-folder)', flexShrink: 0 }} />
          {isRenaming ? renderRenameInput() : <span className="truncate">{node.name}</span>}
          <CloudFileBadge state={cloudState} />
        </div>
        {isOpen && (
          <div style={{ paddingLeft: '12px', borderLeft: '1px solid var(--vscode-border)', marginLeft: '14px' }}>
            {node.children.map(child => (
              <FileNode
                key={child.path}
                node={child}
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
    );
  }

  // Also highlight if it's the opened file, unless we are multi-selecting and it's not in the set
  const isSelected = isMultiSelected || (selectedFile === node.path && (!selectedNodes || selectedNodes.size === 0));
  return (
    <div
      onClick={(e) => {
        if (isRenaming) return;
        handleNodeSelect(node.path, false, e);
      }}
      className={`vscode-tree-node ${isSelected ? 'active' : ''}`}
      style={baseStyle}
      draggable={!isRenaming}
      onDragStart={handleDragStart}
      onContextMenu={(e) => handleNodeContextMenu(e, node)}
    >
      <File size={14} className="text-white" style={{ color: 'var(--vscode-text-muted)', flexShrink: 0 }} />
      {isRenaming ? renderRenameInput() : <span className="truncate">{node.name}{isDirty ? ' *' : ''}</span>}
      <CloudFileBadge state={cloudState} />
    </div>
  );
}
