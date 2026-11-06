export type MermaidTheme = 'default' | 'dark';
export type MermaidResult = { svg: string } | { error: string };

let loaded: Promise<typeof import('mermaid').default> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let renderCount = 0;

// Mermaid keeps one global config, so `initialize` and `render` run as one step, one call at a
// time. Otherwise a concurrent call with the other theme could change the config mid-render.
export function renderMermaid(source: string, theme: MermaidTheme): Promise<MermaidResult> {
  const result = queue.then(() => render(source, theme));
  queue = result;
  return result;
}

async function render(source: string, theme: MermaidTheme): Promise<MermaidResult> {
  try {
    // A failed chunk load is not cached, so the next render tries again.
    loaded ??= import('mermaid')
      .then((module) => module.default)
      .catch((error: unknown) => {
        loaded = undefined;
        throw error;
      });
    const mermaid = await loaded;
    // Strict mode escapes labels, disables click handlers and runs DOMPurify over the whole
    // svg, so the result is safe to insert as HTML.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      suppressErrorRendering: true,
      // A diagram's own `%%{init}%%` directive may not inject CSS into the page.
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'themeCSS',
      ],
    });
    const { svg } = await mermaid.render(`mermaid-${++renderCount}`, source);
    return { svg };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
