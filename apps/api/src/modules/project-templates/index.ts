import { Elysia, t } from 'elysia';
import { noContent } from '#shared/http';
import { assertMcpAllowed, guards } from '#shared/guards';
import { errors } from '#shared/responses';
import { mcpTool } from '#mcp/generate';
import { teamParams } from '#modules/teams/model';
import { workspaceParams } from '#modules/workspaces/model';
import {
  ProjectTemplateContentsResponse,
  ProjectTemplateDetailResponse,
  ProjectTemplateListResponse,
  previewProjectTemplateBody,
  ProjectTemplateResponse,
  importProjectTemplateBody,
  previewImportedTemplateBody,
  saveProjectTemplateBody,
  SharedProjectTemplate,
  teamTemplateParams,
  updateProjectTemplateBody,
  workspaceTemplateParams,
} from './model';
import {
  deleteProjectTemplate,
  getTeamTemplate,
  getWorkspaceTemplate,
  listTeamTemplates,
  listWorkspaceTemplates,
  previewProjectTemplate,
  requireWorkspaceProject,
  saveProjectTemplate,
  updateProjectTemplate,
} from './service';
import { exportProjectTemplate, importProjectTemplate, previewImportedTemplate } from './share';

// The project templates of a workspace: snapshots of a project's configuration that new
// projects are created from (POST /teams/:teamId/projects with templateId). The
// workspace's owner and its admins save, edit and delete them. A team's owners and managers,
// who create its projects, read the ones open to their team.
export const projectTemplateRoutes = new Elysia({
  name: 'project-templates',
  detail: { tags: ['Project Templates'] },
})
  .use(guards)

  .get(
    '/workspaces/:workspaceId/project-templates',
    ({ standing }) => listWorkspaceTemplates(standing.workspaceId),
    {
      workspaceManager: true,
      params: workspaceParams,
      response: { 200: ProjectTemplateListResponse, ...errors(400, 401, 404) },
      detail: {
        summary: 'List the project templates of a workspace',
        description:
          'Every project template of the workspace, by name, with the teams it is limited to. ' +
          'The workspaceId of a team comes from list_teams.',
        ...mcpTool('list_workspace_project_templates'),
      },
    },
  )

  .get(
    '/workspaces/:workspaceId/project-templates/:templateId',
    ({ standing, params }) => getWorkspaceTemplate(standing.workspaceId, params.templateId),
    {
      workspaceManager: true,
      params: workspaceTemplateParams,
      response: { 200: ProjectTemplateDetailResponse, ...errors(400, 401, 404) },
      detail: {
        summary: 'Get a project template of a workspace',
        description:
          'What a project template holds: its states, issue types, labels, custom fields, ' +
          'issue templates, views, dashboards, actions, settings, the sections it turns on ' +
          'and its estimates.',
      },
    },
  )

  .post(
    '/workspaces/:workspaceId/project-templates/preview',
    ({ body, standing }) => previewProjectTemplate(standing.workspaceId, body),
    {
      workspaceManager: true,
      params: workspaceParams,
      body: previewProjectTemplateBody,
      response: { 200: ProjectTemplateContentsResponse, ...errors(400, 401, 404) },
      detail: {
        summary: 'Preview a project template',
        description:
          'What a template saved from the project with this `include` would hold. Saves ' +
          'nothing.',
      },
    },
  )

  .post(
    '/workspaces/:workspaceId/project-templates',
    async ({ body, standing, set, request }) => {
      await requireWorkspaceProject(standing.workspaceId, body.projectId);
      await assertMcpAllowed(body.projectId, request.headers);
      set.status = 201;
      return saveProjectTemplate(standing.workspaceId, body);
    },
    {
      workspaceManager: true,
      params: workspaceParams,
      body: saveProjectTemplateBody,
      response: { 201: ProjectTemplateResponse, ...errors(400, 401, 403, 404) },
      detail: {
        summary: 'Save a project as a template',
        description:
          'Save a snapshot of the configuration of a project of the workspace, without its ' +
          'issues, as a project template. Later changes to the project do not change the ' +
          'template. `include` chooses the sections as for a copy; docs, webhooks, agents ' +
          'and schedules are never saved. `teamIds` limits the template to those teams.',
        ...mcpTool('create_project_template'),
      },
    },
  )

  .get(
    '/workspaces/:workspaceId/project-templates/:templateId/export',
    ({ standing, params }) => exportProjectTemplate(standing.workspaceId, params.templateId),
    {
      workspaceManager: true,
      params: workspaceTemplateParams,
      response: { 200: SharedProjectTemplate, ...errors(400, 401, 404) },
      detail: {
        summary: 'Export a project template',
        description:
          'The template as a document another workspace imports, on this instance or ' +
          'another one. The people, initiatives and cycles it names, the settings other ' +
          'than auto-archive and the subtask automations, and the sections an extension ' +
          'adds are left out. ' +
          'import_project_template takes it as `template`.',
        ...mcpTool('export_project_template'),
      },
    },
  )

  .post(
    '/workspaces/:workspaceId/project-templates/import/preview',
    ({ body }) => previewImportedTemplate(body.template),
    {
      workspaceManager: true,
      params: workspaceParams,
      body: previewImportedTemplateBody,
      response: { 200: ProjectTemplateContentsResponse, ...errors(400, 401, 404) },
      detail: {
        summary: 'Preview an exported project template',
        description:
          'Checks an exported template and answers with what it would hold once imported. ' +
          'Saves nothing.',
      },
    },
  )

  .post(
    '/workspaces/:workspaceId/project-templates/import',
    async ({ body, standing, set }) => {
      set.status = 201;
      return importProjectTemplate(standing.workspaceId, body);
    },
    {
      workspaceManager: true,
      params: workspaceParams,
      body: importProjectTemplateBody,
      response: { 201: ProjectTemplateResponse, ...errors(400, 401, 404) },
      detail: {
        summary: 'Import a project template',
        description:
          'Save an exported template as a template of the workspace, under the `name` and ' +
          '`description` given here. `teamIds` limits it to those teams. The people, ' +
          'initiatives and cycles it names are dropped.',
        ...mcpTool('import_project_template'),
      },
    },
  )

  .patch(
    '/workspaces/:workspaceId/project-templates/:templateId',
    ({ body, standing, params }) =>
      updateProjectTemplate(standing.workspaceId, params.templateId, body),
    {
      workspaceManager: true,
      params: workspaceTemplateParams,
      body: updateProjectTemplateBody,
      response: { 200: ProjectTemplateResponse, ...errors(400, 401, 404) },
      detail: {
        summary: 'Update a project template',
        description:
          'Rename a project template, change its description or the teams it is open to. ' +
          'What it holds stays as saved. `teamIds` null opens it to every team of the ' +
          'workspace.',
        ...mcpTool('update_project_template'),
      },
    },
  )

  .delete(
    '/workspaces/:workspaceId/project-templates/:templateId',
    async ({ standing, params }) => {
      await deleteProjectTemplate(standing.workspaceId, params.templateId);
      return noContent();
    },
    {
      workspaceManager: true,
      params: workspaceTemplateParams,
      response: { 204: t.Void(), ...errors(400, 401, 403, 404) },
      detail: {
        summary: 'Delete a project template',
        description: 'Delete a project template. Projects created from it are not changed.',
        ...mcpTool('delete_project_template'),
      },
    },
  )

  .get(
    '/teams/:teamId/project-templates',
    ({ membership }) => listTeamTemplates(membership.teamId),
    {
      teamManager: true,
      params: teamParams,
      response: { 200: ProjectTemplateListResponse, ...errors(401, 403, 404) },
      detail: {
        summary: 'List the project templates of a team',
        description:
          "The project templates of the team's workspace open to the team, by name. Pass " +
          'its id as templateId to create_project to create a project from it.',
        ...mcpTool('list_project_templates'),
      },
    },
  )

  .get(
    '/teams/:teamId/project-templates/:templateId',
    ({ membership, params }) => getTeamTemplate(membership.teamId, params.templateId),
    {
      teamManager: true,
      params: teamTemplateParams,
      response: { 200: ProjectTemplateDetailResponse, ...errors(400, 401, 403, 404) },
      detail: {
        summary: 'Get a project template',
        description:
          'What a project template open to the team holds: its states, issue types, labels, ' +
          'custom fields, issue templates, views, dashboards, actions, settings, the ' +
          'sections it turns on and its estimates.',
        ...mcpTool('get_project_template'),
      },
    },
  );
