import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { renderMermaid } from './mermaid';

// The web app has no Bun types, so the module is imported by a name tsc does not resolve.
const bunTest = 'bun:test';
const { mock } = await import(bunTest);

let calls: string[];
let renderDelay: (source: string) => number;

mock.module('mermaid', () => ({
  default: {
    initialize: (config: { theme: string; securityLevel: string; startOnLoad: boolean }) => {
      assert.equal(config.securityLevel, 'strict');
      assert.equal(config.startOnLoad, false);
      calls.push(`initialize ${config.theme}`);
    },
    render: async (id: string, source: string) => {
      calls.push(`render ${id} ${source}`);
      await new Promise((resolve) => setTimeout(resolve, renderDelay(source)));
      if (source === 'invalid') throw new Error('Parse error on line 1');
      calls.push(`done ${source}`);
      return { svg: `<svg id="${id}">${source}</svg>` };
    },
  },
}));

beforeEach(() => {
  calls = [];
  renderDelay = () => 0;
});

describe('renderMermaid', () => {
  it('initializes with the theme before the render and returns the svg', async () => {
    const result = await renderMermaid('flowchart TD', 'dark');
    assert.ok('svg' in result);
    assert.ok(result.svg.includes('flowchart TD'));
    assert.equal(calls[0], 'initialize dark');
  });

  it('runs concurrent renders one at a time, each with its own theme', async () => {
    renderDelay = (source) => (source === 'slow' ? 20 : 0);
    await Promise.all([renderMermaid('slow', 'dark'), renderMermaid('fast', 'default')]);
    assert.deepEqual(
      calls.map((call) => call.replace(/ mermaid-\d+/, '')),
      [
        'initialize dark',
        'render slow',
        'done slow',
        'initialize default',
        'render fast',
        'done fast',
      ],
    );
  });

  it('gives each render its own id', async () => {
    await renderMermaid('a', 'default');
    await renderMermaid('b', 'default');
    const ids = calls.filter((call) => call.startsWith('render')).map((call) => call.split(' ')[1]);
    assert.equal(new Set(ids).size, 2);
  });

  it("returns Mermaid's message for invalid syntax and keeps rendering afterwards", async () => {
    assert.deepEqual(await renderMermaid('invalid', 'default'), {
      error: 'Parse error on line 1',
    });
    assert.ok('svg' in (await renderMermaid('valid', 'default')));
  });
});
