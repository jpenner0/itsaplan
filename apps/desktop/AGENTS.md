# desktop

- Do not add a `dev` or `start` script. Root `bun run dev` and `bun run start` run every member and
  must not open an Electron window. Use `bun run electron` here.
- The page gets no preload script and no Node access. Keep `src/server-url.ts` free of Electron and
  Bun APIs so `bun test` runs it.
