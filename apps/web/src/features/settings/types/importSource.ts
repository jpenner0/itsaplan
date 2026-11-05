import type { ComponentType } from 'react';
import type { ProjectDetail } from '@/lib/api/endpoints/projects';

// One tab of the sources on the Import tab: a source with what its tab shows (connect,
// pick what to import, start the job).
export type ImportSourceEntry = {
  key: string;
  label: string;
  Component: ComponentType<{ project: ProjectDetail }>;
};
