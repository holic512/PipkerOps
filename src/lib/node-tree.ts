/**
 * @file node-tree.ts
 * @project PipkerOps
 * @module node-organization
 * @description 节点文件夹祖先、路径与筛选树的共享计算。
 * @logic 按父级构建文件夹优先的树；筛选保留命中节点的祖先，计数覆盖全部后代。
 * @dependencies node/folder data contracts
 * @index_tags nodes, folders, tree, filters
 * @author holic512
 */
export type Folder = { id: string; name: string; parentId: string | null };
type TreeNode = {
  id: string;
  name: string;
  hostname: string | null;
  labels: string[];
  folderId: string | null;
  connected: boolean;
};
export type FolderBranch<T extends TreeNode> = {
  folder: Folder;
  path: string;
  children: FolderBranch<T>[];
  nodes: T[];
  total: number;
  online: number;
};

export function folderAncestors(folderId: string | null, folders: Folder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ids = new Set<string>();
  let current = folderId;
  while (current && !ids.has(current)) {
    const folder = byId.get(current);
    if (!folder) break;
    ids.add(current);
    current = folder.parentId;
  }
  return ids;
}

export function folderPath(folderId: string | null, folders: Folder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return [...folderAncestors(folderId, folders)]
    .reverse()
    .map((id) => byId.get(id)!.name)
    .join(" / ");
}

export function buildNodeTree<T extends TreeNode>(
  nodes: T[],
  folders: Folder[],
  query = "",
  labels: string[] = [],
) {
  const text = query.trim().toLocaleLowerCase();
  const filtered = nodes.filter(
    (node) =>
      labels.every((label) => node.labels.includes(label)) &&
      [
        node.name,
        node.hostname ?? "",
        ...node.labels,
        folderPath(node.folderId, folders),
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(text),
  );
  const sort = (
    a: { name: string; id: string },
    b: { name: string; id: string },
  ) =>
    a.name.localeCompare(b.name, "zh-CN", { numeric: true }) ||
    a.id.localeCompare(b.id);
  const searching = !!text || labels.length > 0;
  const visibleFolders = new Set(
    filtered.flatMap((node) => [...folderAncestors(node.folderId, folders)]),
  );
  // Empty matching folders remain discoverable by name when no tag filter is active.
  if (text && !labels.length)
    for (const folder of folders) {
      if (folderPath(folder.id, folders).toLocaleLowerCase().includes(text))
        for (const id of folderAncestors(folder.id, folders))
          visibleFolders.add(id);
    }
  const branch = (folder: Folder): FolderBranch<T> => {
    const children = folders
      .filter(
        (f) =>
          f.parentId === folder.id && (!searching || visibleFolders.has(f.id)),
      )
      .sort(sort)
      .map(branch);
    const ownNodes = filtered
      .filter((n) => n.folderId === folder.id)
      .sort(sort);
    return {
      folder,
      path: folderPath(folder.id, folders),
      children,
      nodes: ownNodes,
      total:
        ownNodes.length + children.reduce((sum, child) => sum + child.total, 0),
      online:
        ownNodes.filter((n) => n.connected).length +
        children.reduce((sum, child) => sum + child.online, 0),
    };
  };
  return {
    folders: folders
      .filter((f) => !f.parentId && (!searching || visibleFolders.has(f.id)))
      .sort(sort)
      .map(branch),
    nodes: filtered.filter((n) => !n.folderId).sort(sort),
    matched: filtered,
    searching,
  };
}
