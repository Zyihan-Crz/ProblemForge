import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { digest } from './cloud-config.mjs';
import { sandboxRecipe, prepareCloudSandboxes } from './cloud-images.mjs';

const kinds = ['tex', 'judge'];
const id = number => `sha256:${String(number).repeat(64)}`;
const tag = (kind, build) => `problemforge-${kind}:${build}`;
const inputs = {
  '.dockerignore': '.git\nnode_modules\n',
  'infra/tex-sandbox.Dockerfile': 'FROM fixed-base\nCOPY infra/tex-mount.yaml /opt/mount.yaml\n',
  'infra/judge-sandbox.Dockerfile': 'FROM fixed-base\nCOPY --chmod=755 infra/java17-compile.sh /usr/bin/compile\nCOPY infra/judge-mount.yaml /opt/mount.yaml\n',
  'infra/tex-mount.yaml': 'tex mount', 'infra/judge-mount.yaml': 'judge mount',
  'infra/java17-compile.sh': '#!/bin/sh\n', 'apps/web/example.ts': 'old application',
};

async function fixture(t, changes = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pf-cloud-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function release(buildId, files) {
    const path = join(root, buildId), manifest = { buildId, files: [] };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(path, name)), { recursive: true }); await writeFile(join(path, name), text);
      manifest.files.push({ path: name, sha256: digest(text) });
    }
    return { path, manifest };
  }
  const previous = await release('old-release', inputs);
  const next = await release('new-release', { ...inputs, 'apps/web/example.ts': 'new application', ...changes });
  const images = new Map(kinds.map((kind, i) => [tag(kind, 'old-release'), id(i + 1)]));
  const rows = kinds.map((kind, i) => ({ id: String(i + 1).repeat(64), project: 'problemforge-cloud', service: `${kind}-sandbox`,
    state: 'running', image: tag(kind, 'old-release'), imageId: id(i + 1) }));
  const commands = [], builds = [], saves = [];
  const docker = async args => {
    commands.push(args);
    if (args[0] === 'image') {
      if (args[1] === 'ls') return images.get(args.at(-1)) ?? '';
      if (args[1] === 'inspect') return images.get(args[2]) ?? '';
      if (args[1] === 'tag') { images.set(args[3], args[2]); return ''; }
    }
    if (args[0] === 'ps') return rows.filter(row => args.at(-1).endsWith(`=${row.service}`)).map(row => row.id).join('\n');
    if (args[0] === 'inspect') return JSON.stringify(rows.find(row => row.id === args.at(-1)));
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };
  const options = { directory: next.path, manifest: next.manifest, previous, docker, say: () => {},
    build: async service => { builds.push(service); const kind = service.split('-')[0]; images.set(tag(kind, 'new-release'), id(kinds.indexOf(kind) + 3)); },
    save: async receipt => { saves.push(structuredClone(receipt)); },
  };
  return { previous, next, options, builds, images, rows, commands, saves };
}

test('application-only updates reuse exactly the running project images without any builds', async t => {
  const f = await fixture(t);
  const receipt = await prepareCloudSandboxes(f.options);
  assert.deepEqual(f.builds, []);
  assert.equal(f.commands.filter(args => args[1] === 'tag').length, 2);
  for (const kind of kinds) assert.equal(receipt.images[kind].imageId, f.images.get(tag(kind, 'old-release')));
  assert.equal(f.saves.length, 2);
  f.commands.length = 0;
  assert.deepEqual(await prepareCloudSandboxes({ ...f.options, receipt }), receipt);
  assert.deepEqual(f.builds, []);
  assert.equal(f.commands.filter(args => args[1] === 'tag').length, 0);
});

test('changed compiler wrapper rebuilds only Judge; failed build retries reuse already prepared TeX', async t => {
  const f = await fixture(t, { 'infra/java17-compile.sh': '#!/bin/sh\necho updated\n' });
  await assert.rejects(prepareCloudSandboxes({ ...f.options, build: async service => {
    assert.equal(service, 'judge-sandbox'); throw new Error('download failed');
  } }), /download failed/);
  assert.equal(f.saves.length, 1);
  assert.deepEqual(Object.keys(f.saves[0].images), ['tex']);
  const receipt = await prepareCloudSandboxes({ ...f.options, receipt: f.saves[0] });
  assert.deepEqual(f.builds, ['judge-sandbox']);
  assert.equal(receipt.images.tex.imageId, id(1));
  assert.equal(receipt.images.judge.imageId, id(4));
});

test('fresh installs build both sandboxes', async t => {
  const f = await fixture(t);
  await prepareCloudSandboxes({ ...f.options, previous: null });
  assert.deepEqual(f.builds, ['tex-sandbox', 'judge-sandbox']);
});

test('different Dockerfile and dockerignore contents invalidate the affected recipes', async t => {
  const f = await fixture(t, { 'infra/judge-sandbox.Dockerfile': inputs['infra/judge-sandbox.Dockerfile'] + 'RUN echo patched\n' });
  await prepareCloudSandboxes(f.options);
  assert.deepEqual(f.builds, ['judge-sandbox']);
  const g = await fixture(t, { '.dockerignore': '.git\nnode_modules\n*.log\n' });
  await prepareCloudSandboxes(g.options);
  assert.deepEqual(g.builds, ['tex-sandbox', 'judge-sandbox']);
});

test('changed or unrecorded target tags are never overwritten', async t => {
  const f = await fixture(t);
  f.images.set(tag('tex', 'new-release'), id(9));
  await assert.rejects(prepareCloudSandboxes(f.options), /没有本次构建记录/);
  assert.equal(f.commands.filter(args => args[1] === 'tag').length, 0);
  f.images.delete(tag('tex', 'new-release'));
  const receipt = await prepareCloudSandboxes(f.options);
  f.images.set(tag('tex', 'new-release'), id(9));
  await assert.rejects(prepareCloudSandboxes({ ...f.options, receipt }), /已记录镜像发生变化/);
});

test('foreign, stopped, ambiguous or retagged running sandboxes are rejected before reuse', async t => {
  for (const change of [row => { row.project = 'other-project'; }, row => { row.state = 'exited'; },
    row => { row.image = tag('tex', 'foreign-release'); }, row => { row.imageId = id(9); }]) {
    const f = await fixture(t); change(f.rows[0]);
    await assert.rejects(prepareCloudSandboxes(f.options), /归属或镜像/);
    assert.equal(f.commands.filter(args => args[1] === 'tag').length, 0);
    assert.deepEqual(f.builds, []);
  }
  const f = await fixture(t); f.rows.push({ ...f.rows[0], id: '9'.repeat(64) });
  await assert.rejects(prepareCloudSandboxes(f.options), /恰有一个/);
});

test('recipe checks reject tampered inputs, unsupported COPY forms and invalid receipts', async t => {
  const f = await fixture(t);
  await writeFile(join(f.next.path, 'infra/tex-mount.yaml'), 'tampered');
  await assert.rejects(sandboxRecipe(f.next.path, f.next.manifest, 'tex'), /校验失败/);
  for (const copy of ['COPY infra/* /opt/', 'COPY ["infra/tex-mount.yaml", "/opt/"]', 'COPY infra/tex-mount.yaml \\\n /opt/', 'COPY --from=other /mount /opt/']) {
    const g = await fixture(t, { 'infra/tex-sandbox.Dockerfile': `FROM fixed-base\n${copy}\n` });
    await assert.rejects(sandboxRecipe(g.next.path, g.next.manifest, 'tex'), /COPY/);
  }
  const g = await fixture(t);
  for (const receipt of [{ format: 2 }, { format: 1, buildId: 'new-release', images: [] }, { format: 1, buildId: 'new-release', images: { foreign: {} } }]) {
    await assert.rejects(prepareCloudSandboxes({ ...g.options, receipt }), /记录无效/);
  }
});
