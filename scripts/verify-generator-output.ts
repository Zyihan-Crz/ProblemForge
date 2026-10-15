import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { db } from '@problemforge/database';
import { config, sha256 } from '@problemforge/domain';
import { MAX_TEST_BYTES, defaultJudgeSettings } from '@problemforge/contracts';
import { SandboxClient } from '../packages/judge-adapter/src/index.ts';
import { Executor, type Compiled } from '../workers/judge/src/executor.ts';

// Explicit check against the configured Linux sandbox only. No listener, queue,
// persistent storage, business rows, or host-side author program execution.
if (!process.argv.includes('--sandbox')) throw new Error('请显式指定 --sandbox');
if (!config.judgeSandboxToken) throw new Error('缺少 Judge 沙箱配置');
const sandbox = new SandboxClient(config.judgeSandboxUrl, config.judgeSandboxToken);
const savedCreate = db.invocation.create;
const invocations: any[] = [];
(db.invocation as any).create = async ({ data }: any) => { invocations.push(data); return { id: `fixture-${invocations.length}` }; };
const executor = new Executor('output-limit-fixture', sandbox, { put: async () => {} } as any, new AbortController().signal, '', { problemId: 'fixture', leaseToken: 'fixture' });
executor.progress = async () => ({ count: 1 });
const evidence: object[] = [];
try {
  const active = { builds: await db.build.count({ where: { state: { in: ['QUEUED', 'RUNNING'] } } }), runs: await db.testRun.count({ where: { state: { in: ['QUEUED', 'RUNNING'] } } }) };
  assert.deepEqual(active, { builds: 0, runs: 0 }, 'existing sandbox must be idle');
  const version = await sandbox.health();
  const makeProgram = async (source: string): Promise<Compiled> => ({
    program: { id: 'fixture', revisionId: 'fixture', name: 'output boundary', profile: { language: 'PYTHON3' } } as Compiled['program'],
    executable: await executor.upload(Buffer.from(source)), fileName: 'main.py',
  });
  const generator = await makeProgram(`import sys\nn = int(sys.argv[1])\nchunk = b'A' * 65536\nwhile n:\n size = min(n, len(chunk))\n sys.stdout.buffer.write(chunk[:size])\n n -= size\n`);
  for (const [size, repeat] of [[8_000_001, false], [8_000_001, true], [MAX_TEST_BYTES, false], [MAX_TEST_BYTES + 1, false]] as const) {
    const result = await executor.generate(generator, [String(size)], '3003', `size-${size}`, repeat);
    assert.equal(result.verdict, size > MAX_TEST_BYTES ? 'OLE' : 'AC', result.diagnostic);
    if (size <= MAX_TEST_BYTES) {
      assert.equal(result.output?.length, size);
      assert.equal(result.outputRef?.hash, sha256(Buffer.alloc(size, 65)));
    } else assert.match(result.diagnostic, /生成器输出超限/);
    evidence.push({ size, repeat, verdict: result.verdict, stdoutBytes: result.stdout.length, hash: result.outputRef?.hash, diagnostic: result.diagnostic });
  }
  const solution = await makeProgram('import sys\nsys.stdout.buffer.write(b"A" * 4097)\n');
  const small = await executor.solution(solution, Buffer.from('1\n'), { ...defaultJudgeSettings, outputLimitBytes: 4096 }, 'solution-limit');
  assert.equal(small.verdict, 'OLE');
  evidence.push({ solutionOutputLimit: 4096, verdict: small.verdict });
  const noisy = await makeProgram('import sys\nsys.stderr.buffer.write(b"X" * 65537)\n');
  const stderr = await executor.generate(noisy, [], '3003', 'stderr-limit');
  assert.equal(stderr.verdict, 'OLE');
  assert.match(stderr.diagnostic, /stderr.*64 KiB/);
  evidence.push({ stderrLimit: 65536, verdict: stderr.verdict });
  // Checker self-tests can copy three maximum-sized files into /w at once.
  const checker = await makeProgram(`import os,sys\nassert [os.path.getsize(p) for p in sys.argv[1:]] == [${MAX_TEST_BYTES}] * 3\n`);
  const large = Buffer.alloc(MAX_TEST_BYTES, 65);
  const checked = await executor.check(checker, large, large, large, { selfTestId: 'fixture' }, 'CHECKER_SELF_TEST');
  assert.equal(checked.verdict, 'AC', checked.diagnostic);
  evidence.push({ checkerFiles: 3, bytesPerFile: MAX_TEST_BYTES, verdict: checked.verdict });
  await mkdir('.local/generator-limit', { recursive: true });
  const result = { passed: true, version, maxBytes: MAX_TEST_BYTES, evidence, persistentRows: 0, storedFiles: 0 };
  await writeFile('.local/generator-limit/sandbox-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { db.invocation.create = savedCreate; await executor.cleanup(); await db.$disconnect(); }
