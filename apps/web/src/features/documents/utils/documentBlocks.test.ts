import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSchema } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { documentEditorExtensions } from '../components/DocumentMarkdownEditor';
import { documentBlockRange } from './documentBlocks';

const schema = getSchema(
  documentEditorExtensions({ placeholder: '', codeBlockLabel: '', tableLabel: '' }),
);

describe('documentBlockRange', () => {
  it('returns no block for a position past the end of the document', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('Hi'))]);
    const editor = { state: { doc } } as Editor;
    assert.equal(documentBlockRange(editor, doc.content.size + 10), null);
  });
});
