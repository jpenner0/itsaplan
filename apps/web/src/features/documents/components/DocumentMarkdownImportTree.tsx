import type { PreviewNode } from '../utils/markdownFolderImport';

export default function DocumentMarkdownImportTree({ nodes }: { nodes: PreviewNode[] }) {
  return (
    <ul className="ms-4 space-y-0.5 border-s ps-2 first:ms-0 first:border-s-0 first:ps-0">
      {nodes.map((node, index) => (
        <li key={index}>
          <span dir="auto">{node.title}</span>
          {node.children.length > 0 && <DocumentMarkdownImportTree nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}
