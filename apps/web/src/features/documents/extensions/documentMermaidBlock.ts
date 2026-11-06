import type { NodeView } from '@tiptap/pm/view';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { ReactNodeViewRenderer } from '@tiptap/react';
import DocumentMermaidBlock from '../components/DocumentMermaidBlock';

const isMermaid = (language: unknown) => language === 'mermaid';

// The node stays a plain `codeBlock`, so its Markdown, collaboration and comments are unchanged.
// Only a block with the language `mermaid` gets the React view.
export const DocumentMermaidCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    const mermaidView = ReactNodeViewRenderer(DocumentMermaidBlock, {
      // A language change away from `mermaid` recreates the view as a plain code block.
      update: ({ newNode, updateProps }) => {
        if (!isMermaid(newNode.attrs.language)) return false;
        updateProps();
        return true;
      },
      // Keeps the block id on the wrapper, so a link to the block still finds it.
      attrs: ({ HTMLAttributes }) => HTMLAttributes,
    });
    // Without a view ProseMirror renders the node from `renderHTML`, as before. A plain code block
    // whose language becomes `mermaid` changes its markup, so ProseMirror asks this factory again.
    return (props) =>
      isMermaid(props.node.attrs.language) ? mermaidView(props) : (null as unknown as NodeView);
  },
});
