import { useCallback, useSyncExternalStore } from 'react';
import type { Editor } from '@tiptap/core';

// `setEditable(…, false)` emits no editor event, so this watches the attribute ProseMirror sets.
export function useEditorEditable(editor: Editor): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const observer = new MutationObserver(onChange);
      observer.observe(editor.view.dom, { attributes: true, attributeFilter: ['contenteditable'] });
      return () => observer.disconnect();
    },
    [editor],
  );
  return useSyncExternalStore(
    subscribe,
    () => editor.isEditable,
    () => false,
  );
}
