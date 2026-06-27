import React, { useState } from 'react';
import { Folder, File, ChevronRight, ChevronDown } from 'lucide-react';

// Recursive file/directory tree node with drag-and-drop support.
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
}) {
  const isDir = node.isDirectory;
  const [isOpen, setIsOpen] = useState(false);

  const handleDragStart = (e) => {
    e.stopPropagation();
    setDraggedNode({ path: node.path, isDirectory: node.isDirectory });
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDir) return;
    if (draggedNode && draggedNode.path !== node.path) {
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
    if (draggedNode && draggedNode.path !== node.path) {
      handleMoveNode(draggedNode.path, node.path, draggedNode.isDirectory);
    }
  };

  const isDragOver = dragOverPath === node.path;
  let baseStyle = isDragOver ? { backgroundColor: '#2d2d2d', border: '1px dashed #007acc' } : {};

  // Check if node is part of the multi-selection
  const isMultiSelected = selectedNodes && selectedNodes.has(node.path);

  const isDirty = !isDir && originalFileContents && fileContents?.[node.path] !== originalFileContents[node.path] && originalFileContents[node.path] !== undefined;

  if (isDir) {
    return (
      <div
        className="select-none"
        draggable="true"
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          onClick={(e) => {
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
          <Folder size={14} className="text-white" style={{ color: '#e8a838' }} />
          <span className="truncate">{node.name}</span>
        </div>
        {isOpen && (
          <div style={{ paddingLeft: '12px', borderLeft: '1px solid #3c3c3c', marginLeft: '14px' }}>
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
      onClick={(e) => handleNodeSelect(node.path, false, e)}
      className={`vscode-tree-node ${isSelected ? 'active' : ''}`}
      style={baseStyle}
      draggable="true"
      onDragStart={handleDragStart}
      onContextMenu={(e) => handleNodeContextMenu(e, node)}
    >
      <File size={14} className="text-white" style={{ color: '#808080' }} />
      <span className="truncate">{node.name}{isDirty ? ' *' : ''}</span>
    </div>
  );
}
