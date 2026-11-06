'use client';

import { useEffect, useState } from 'react';
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { Check, Copy, Pencil, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEditorEditable } from '../hooks/useEditorEditable';
import DocumentMermaidDiagram from './DocumentMermaidDiagram';

// Keeps typing smooth: renders run one at a time, so each keystroke would queue its own.
const PREVIEW_DELAY_MS = 300;

export default function DocumentMermaidBlock({
  node,
  editor,
  getPos,
  selectionInside,
}: ReactNodeViewProps) {
  const t = useTranslations('documents.mermaid');
  const editable = useEditorEditable(editor);
  const [editingCode, setEditingCode] = useState(false);
  const source = node.textContent;
  const previewSource = useDebouncedValue(source, PREVIEW_DELAY_MS);
  const showCode = editable && editingCode;

  // The source stays in the document while hidden, so a caret moved into it opens the code.
  useEffect(() => {
    if (selectionInside && editor.isFocused) setEditingCode(true);
  }, [selectionInside, editor]);

  function done() {
    setEditingCode(false);
    const position = getPos();
    if (typeof position === 'number') editor.commands.setNodeSelection(position);
  }

  function copyCode() {
    void navigator.clipboard
      .writeText(source)
      .then(() => toast.success(t('codeCopied')))
      .catch(() => toast.error(t('copyFailed')));
  }

  let action: { icon: LucideIcon; label: string; onClick: () => void };
  if (!editable) action = { icon: Copy, label: t('copyCode'), onClick: copyCode };
  else if (showCode) action = { icon: Check, label: t('done'), onClick: done };
  else action = { icon: Pencil, label: t('editCode'), onClick: () => setEditingCode(true) };

  return (
    <NodeViewWrapper className="my-4 flex flex-col gap-2 rounded-md border p-3">
      <div contentEditable={false} className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={action.onClick}>
          <action.icon />
          {action.label}
        </Button>
      </div>
      <pre dir="ltr" className={showCode ? 'my-0' : 'hidden'}>
        <NodeViewContent<'code'> as="code" />
      </pre>
      <div contentEditable={false}>
        <DocumentMermaidDiagram
          source={showCode ? previewSource : source}
          keepLastDiagram={showCode}
        />
      </div>
    </NodeViewWrapper>
  );
}
