'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { renderMermaid } from '@/lib/mermaid';

// Below this scale a diagram's text gets hard to read, so the block scrolls instead.
const MIN_SCALE = 0.5;

type Props = {
  source: string;
  // On invalid syntax, keep the last valid diagram and show the error below it, without the
  // source. For a live preview next to the code.
  keepLastDiagram?: boolean;
};

export default function DocumentMermaidDiagram({ source, keepLastDiagram }: Props) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diagramRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The theme is unknown during the server render and the first client render.
    if (!resolvedTheme) return;
    let current = true;
    renderMermaid(source, resolvedTheme === 'dark' ? 'dark' : 'default').then((result) => {
      if (!current) return;
      if ('svg' in result) {
        setSvg(result.svg);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => {
      current = false;
    };
  }, [source, resolvedTheme]);

  const showDiagram = svg !== null && (!error || keepLastDiagram);

  useLayoutEffect(() => {
    const element = diagramRef.current?.querySelector('svg');
    const width = element?.viewBox.baseVal?.width;
    if (element && width) element.style.minWidth = `${width * MIN_SCALE}px`;
  }, [svg, showDiagram]);

  return (
    <div dir="ltr" className="flex flex-col gap-2">
      {showDiagram && (
        <div
          ref={diagramRef}
          className="overflow-x-auto [&_svg]:mx-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {error && <pre className="text-sm whitespace-pre-wrap text-destructive">{error}</pre>}
      {error && !keepLastDiagram && (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm">
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
