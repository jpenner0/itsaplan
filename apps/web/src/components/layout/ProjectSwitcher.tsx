import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '@/lib/api/endpoints/projects';
import { useSession } from '@/lib/auth-client';
import { useTeamsQuery } from '@/services/teams.service';
import { useWorkspacesQuery } from '@/services/workspaces.service';
import { qk } from '@/services/queryKeys';
import { Popover, PopoverTrigger } from '@/components/ui/popover';
import { SidebarMenu, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import ProjectSwitcherTrigger from './ProjectSwitcherTrigger';
import ProjectSwitcherMenu from './ProjectSwitcherMenu';
import { useProjectSwitcherPreferences } from './hooks/useProjectSwitcherPreferences';

// What the list beside the workspaces shows: the hidden projects, or the projects of one
// team, by its id.
export type ProjectSwitcherScope = 'hidden' | number;

export default function ProjectSwitcher({
  projects,
  currentProjectKey,
  onSelectProject,
}: {
  projects: Project[];
  currentProjectKey: string | null;
  onSelectProject: (key: string) => void;
}) {
  const { isMobile } = useSidebar();
  const teamsQuery = useTeamsQuery();
  const teams = teamsQuery.data ?? [];
  const workspaces = useWorkspacesQuery().data ?? [];
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const preferences = useProjectSwitcherPreferences(session?.user.id);
  const current = projects.find((project) => project.ref === currentProjectKey);
  const [open, setOpen] = useState(false);
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<number | null>(null);
  const [scope, setScope] = useState<ProjectSwitcherScope | null>(null);

  // A project reaches its workspace through its team, so nothing is narrowed until the
  // teams have loaded.
  const currentWorkspaceId = teams.find((team) => team.id === current?.teamId)?.workspaceId;
  const workspace = teamsQuery.data
    ? (workspaces.find((entry) => entry.id === (pickedWorkspaceId ?? currentWorkspaceId)) ??
      workspaces[0])
    : undefined;
  const workspaceTeams = workspace
    ? teams.filter((team) => team.workspaceId === workspace.id)
    : teams;
  const currentTeam = workspaceTeams.find((team) => team.id === current?.teamId);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover
          modal={isMobile}
          open={open}
          onOpenChange={(value) => {
            setOpen(value);
            if (!value) return;
            setPickedWorkspaceId(null);
            setScope(null);
            void queryClient.invalidateQueries({ queryKey: qk.projects });
          }}
        >
          <PopoverTrigger asChild>
            <ProjectSwitcherTrigger current={current} />
          </PopoverTrigger>
          <ProjectSwitcherMenu
            workspaces={workspaces}
            workspace={workspace}
            teams={workspaceTeams}
            currentTeam={currentTeam}
            scope={scope ?? currentTeam?.id ?? workspaceTeams[0]?.id}
            onScopeChange={setScope}
            onPickWorkspace={(workspaceId) => {
              setPickedWorkspaceId(workspaceId);
              setScope(null);
            }}
            currentProjectKey={currentProjectKey}
            preferences={preferences}
            onSelectProject={(key) => {
              setOpen(false);
              onSelectProject(key);
            }}
            onClose={() => setOpen(false)}
          />
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
