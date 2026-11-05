'use client';

import type { ImportSourceEntry } from '@/features/settings/types/importSource';

// A self-hosted instance imports from the core's sources. The hosted build returns the
// core's with its own added at any position.
export default function useImportSources(core: ImportSourceEntry[]): ImportSourceEntry[] {
  return core;
}
