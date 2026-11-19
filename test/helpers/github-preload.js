// Preload for child-process tests of scripts/*: `node --import ./test/helpers/github-preload.js scripts/sync.js`.
// Replaces global fetch with the in-memory GitHub described by the JSON file named in MOCK_GITHUB_FILE.
import { readFileSync } from 'node:fs';
import { mockGitHub } from './github.js';

// `node --test` also loads every file under test/: without the variable this file does nothing.
if (process.env.MOCK_GITHUB_FILE) {
  const spec = JSON.parse(readFileSync(process.env.MOCK_GITHUB_FILE, 'utf8'));
  globalThis.fetch = mockGitHub(spec).fetch;
}
