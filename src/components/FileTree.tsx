import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '../types';

export type TreeNode = {
  entry: FileEntry;
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
};

type Props = {
  onOpenPath?: (path: string) => void;
  onRootChange?: (path: string) => void;
};

function buildNodes(entries: FileEntry[]): TreeNode[] {
  return entries.map((entry) => ({ entry }));
}

export function FileTree({ onOpenPath, onRootChange }: Props) {
  const [rootPath, setRootPath] = useState('');
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    const loadRoot = async () => {
      const root = await invoke<string>('default_root');
      setRootPath(root);
      onRootChange?.(root);
      const entries = await invoke<FileEntry[]>('list_dir', { path: root });
      setNodes(buildNodes(entries));
    };

    loadRoot().catch(() => {
      // ignore load errors for now
    });
  }, []);

  const onToggle = async (node: TreeNode) => {
    if (!node.entry.is_dir) {
      setSelectedPath(node.entry.path);
      onOpenPath?.(node.entry.path);
      return;
    }

    if (node.expanded) {
      node.expanded = false;
      setNodes([...nodes]);
      return;
    }

    node.expanded = true;
    node.loading = true;
    setNodes([...nodes]);

    try {
      const entries = await invoke<FileEntry[]>('list_dir', { path: node.entry.path });
      node.children = buildNodes(entries);
    } catch {
      node.children = [];
    } finally {
      node.loading = false;
      setNodes([...nodes]);
    }
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const isSelected = selectedPath === node.entry.path;
    return (
      <div key={node.entry.path}>
        <div
          className={`tree-row ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          onClick={() => onToggle(node)}
        >
          <span className={`tree-icon ${node.entry.is_dir ? 'dir' : 'file'}`}>
            {node.entry.is_dir ? (node.expanded ? '▾' : '▸') : '•'}
          </span>
          <span className="tree-name">{node.entry.name}</span>
        </div>
        {node.expanded && node.loading && <div className="tree-loading">loading…</div>}
        {node.expanded && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const treeContent = useMemo(() => nodes.map((node) => renderNode(node, 0)), [nodes]);

  const handleRootSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rootPath) return;
    try {
      const entries = await invoke<FileEntry[]>('list_dir', { path: rootPath });
      setNodes(buildNodes(entries));
      onRootChange?.(rootPath);
    } catch {
      // ignore
    }
  };

  return (
    <div className="sidebar">
      <form className="sidebar-header" onSubmit={handleRootSubmit}>
        <div className="sidebar-title">Repository</div>
        <input
          className="sidebar-input"
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          placeholder="/path/to/project"
        />
      </form>
      <div className="sidebar-tree">{treeContent}</div>
    </div>
  );
}
