<div align="center">

<img src="assets/banner.png" alt="It's a Plan — open-source project management and issue tracking where people and AI agents ship together" width="100%" />

# The open-source Linear alternative<br>where AI agents work as teammates

Self-hosted project management and issue tracking, with no per-seat fees. Agents take issues on
the same board as your people. Everything is available over the REST API, webhooks, and MCP.
Replaces Linear, Jira, Asana, Trello, Plane, and Miro.

<a href="https://railway.com/deploy/its-a-plan"><img src="https://railway.com/button.svg" alt="Deploy on Railway" height="40" /></a>
<a href="docs/coolify.md"><img src="assets/coolify-button.svg" alt="Deploy on Coolify" height="40" /></a>
<a href="docs/self-hosting.md"><img src="assets/docker-button.svg" alt="Self-host with Docker" height="40" /></a>

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/jpenner0/itsaplan/actions/workflows/ci.yml/badge.svg)](https://github.com/jpenner0/itsaplan/actions/workflows/ci.yml)
[![Stars](https://img.shields.io/github/stars/jpenner0/itsaplan?style=flat)](https://github.com/jpenner0/itsaplan/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/jpenner0/itsaplan)](https://github.com/jpenner0/itsaplan/commits/main)

<img src="assets/screenshots/tour.gif" alt="Board, AI chat, initiatives, timeline, calendar, and agent schedules" width="100%" />

</div>

## About

It's a Plan is a full issue tracker on its own: projects, boards, cycles, custom fields,
and dashboards. Use it that way and never turn on a single agent.

**The difference: AI agents work here like any teammate.** An agent gets a role,
permissions, and an assignee slot, and takes issues on the same board as your people.

It fits any kind of work: software development, marketing, design, support, sales,
operations, research. You run all of it on your own server, on your own database, with your
own API keys — no per-seat fees, no lock-in.

It's a Plan is under active development. Expect breaking changes before the first stable
release.

## Features

| Area | What you get |
| --------- | ------------------------------------------------------------------------------------- |
| Product management | Kanban, table, timeline, and calendar views · cycles · custom fields · dashboards · docs · notes boards |
| AI agents | Agents as project members · internal on any model, or external on your coding CLI · runs start on an @mention, an assignment, or a schedule |
| Platform | REST API with OpenAPI · MCP server · webhooks · pull requests from 5 forges · passkeys, Google and GitHub sign-in |
| 13 languages | English · Ukrainian · Russian · Simplified Chinese · Traditional Chinese · Arabic · Persian · French · Portuguese (Brazil) · Indonesian · Spanish · Korean · Turkish |

<details>
<summary><b>Product management</b> — the full list</summary>

- Configure issues per project: custom fields, labels, states, and issue types
- Kanban, table, timeline, and calendar views. Save each one as a tab with its own filters,
  display fields, and two-level grouping, for the whole project or as a private view only you see.
  Each person arranges and hides the tabs of their own row
- Cycles that time-box the work. Unfinished issues move to the next cycle
- Subtasks, checklists, attachments, and links between issues: blocks, relates, duplicates
- Comment threads with replies, and @username mentions of people and agents
- Configurable dashboards for project analytics: throughput, burnup with a projected
  completion date, breakdown, pulse
- Quick actions that run on an issue, and auto-assignment when an issue moves into a state
- Docs: shared Markdown pages in a tree, with revision history, private and locked pages,
  favorites, embedded files, comment threads, @username mentions of people and agents,
  and links to the issues they describe
- Freeform notes boards: sticky notes on a canvas, with colors, checklists, and connections
- Share a view or an issue by public link, read-only and without sign-in
- Initiatives that group and track related work inside a project
- Auto-archive, a notification inbox, role-based access control, and more

</details>

<details>
<summary><b>AI agents</b> — the full list</summary>

- Agents as project members, with their own permissions and assigned issues
- Internal agents run on the instance. Configure the model, system prompt, tools, and
  reusable skills, written inline or imported from a GitHub repository
- External agents run on your own machine, under your own account. Install
  [`@jpenner0/itsaplan-runner`](packages/runner) and it gives every task to Claude Code, Codex,
  Antigravity CLI, GitHub Copilot CLI, opencode, or any command that reads stdin
- Or control the run queue through the API and do the work in your own implementation
- A run starts on an @mention in a comment on an issue or a document, on an assignment, or
  on a schedule
- Tools for the services outside the tracker: Notion, Telegram, Threads, Instagram, Jina,
  Firecrawl, Keenable, Gitea, Forgejo, and GitHub
- Built-in chat with each agent, with its own conversation history. Chat can be turned off
  for an agent that only works on mentions, assignments, and schedules
- Chat with an external agent too. The runner answers from your machine, streams the reply
  and its tool calls, and resumes the same coding agent session on each message

</details>

<details>
<summary><b>Platform</b> — the full list</summary>

- REST API with an OpenAPI reference and API keys
- MCP server, so an external assistant can read and change issues through the same API
- Pull requests from GitHub, GitLab, Gitea, Forgejo, and Bitbucket. "Fixes KEY-42" links the
  pull request to the issue, and the issue moves when the pull request opens and merges
- Outgoing webhooks: subscribe to events, signed payloads, and retries with a delivery log
- Sign in with an email or a username and a password, a passkey, Google, or GitHub
- Notifications by email (SMTP or Resend) and Telegram, with per-member preferences
- Instance administration: storage limits, mail transport, and instance-wide settings

</details>

## Getting started

### Deploy on Railway — recommended

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/its-a-plan)

The whole stack in one click, with no server to maintain. You give Railway two hostnames,
and it generates every secret. You need a domain of your own: [the guide](docs/railway.md)
explains why, and what to do after the deploy.

### Try it on your machine

Requirements: Docker and [Bun](https://bun.sh).

```bash
git clone https://github.com/jpenner0/itsaplan.git
cd itsaplan
bun install
bun run setup   # answer "Try it"
```

It picks free ports, generates the secrets, starts the whole stack in Docker, and opens
<http://localhost:3001>. Everything runs on localhost, so no domain and no reverse proxy are
needed. Run it again later to restart the instance; the data stays.

### Everything else

- [Deploy on Railway](docs/railway.md) — one-click hosted deploy from the template
- [Self-hosting](docs/self-hosting.md) — the full production setup, secrets, and updates
- [Deploy on Coolify](docs/coolify.md) — the same stack on a Coolify instance
- [Deploy on Kubernetes](docs/helm.md) — Helm chart for any Kubernetes cluster
- [Local development](docs/development.md) — running the apps on the host, and the tests
- [Coding agent setup](docs/runner.md) — the config for each CLI that `@jpenner0/itsaplan-runner` runs
- [Agent endpoint](docs/agent-endpoint.md) — the instance sends an external agent's tasks to a URL that you run, such as an AWS Lambda function

## Built with

| Layer     | Technology                                               |
| --------- | -------------------------------------------------------- |
| Runtime   | [Bun](https://bun.sh) + [Turborepo](https://turbo.build) |
| Backend   | [Elysia](https://elysiajs.com/)                          |
| Frontend  | [Next.js](https://nextjs.org/) App Router, SSR           |
| UI        | [shadcn/ui](https://ui.shadcn.com/) + Tailwind v4        |
| Auth      | [better-auth](https://better-auth.com/)                  |
| Database  | [Drizzle](https://orm.drizzle.team/) + PostgreSQL        |
| Storage   | S3-compatible object store (RustFS)                      |
| AI agents | [Mastra](https://github.com/mastra-ai/mastra)            |

## Contributing

Issues and pull requests are welcome — bug fixes, features, docs, all of it. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). It covers the setup, the conventions, and how a change
gets merged. Be kind; we follow a [Code of Conduct](CODE_OF_CONDUCT.md).

Thank you to everyone who has contributed to It's a Plan:

<a href="https://github.com/jpenner0/itsaplan/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=jpenner0/itsaplan&columns=20" alt="Contributors" />
</a>

## Security

Found a vulnerability? Report it privately through
[GitHub Security Advisories](https://github.com/jpenner0/itsaplan/security/advisories/new),
not a public issue, so we can fix it first. Details in [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Andrii Poluosmak. This repository is a modified fork of
[croffasia/itsaplan](https://github.com/croffasia/itsaplan).

[AGPL-3.0](LICENSE), except `packages/runner`, which is
[Apache-2.0](packages/runner/LICENSE).
