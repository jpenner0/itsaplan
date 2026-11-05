'use client';

import type { WorkspaceSummary } from '@/lib/api/endpoints/workspaces';
import type { WorkspaceSection } from '@/features/teams/types/workspaceSection';

// A self-hosted instance lists the core's workspace settings sections. The hosted build
// returns the core's with its own added at any position, or with one left out.
export default function useWorkspaceSections(
  _workspace: WorkspaceSummary,
  core: WorkspaceSection[],
): WorkspaceSection[] {
  return core;
}
