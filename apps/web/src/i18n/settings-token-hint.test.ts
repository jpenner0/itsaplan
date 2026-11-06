import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { it } from 'node:test';

it('names the issue and webhook rights in the GitHub token hint of every language', () => {
  const root = new URL('../../messages/', import.meta.url);
  for (const locale of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const settings = JSON.parse(
      readFileSync(new URL(`${locale.name}/settings.json`, root), 'utf8'),
    );
    const hint: string = settings.git.nativeTokenHint.github;
    assert.match(hint, /Issues/, locale.name);
    assert.match(hint, /public_repo/, locale.name);
    assert.match(hint, /admin:repo_hook/, locale.name);
  }
});
