import { describe, it, expect } from 'vitest';
import { runBinary } from '../../src/v2/binaryRunner';

describe('runBinary', () => {
  it('capture stdout d\'un binaire qui exit 0', async () => {
    const r = await runBinary({ bin: 'echo', args: ['hello world'] });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello world');
    expect(r.timedOut).toBe(false);
  });

  it('capture stderr et exit code non-zero', async () => {
    const r = await runBinary({
      bin: 'sh',
      args: ['-c', 'echo erreur >&2; exit 3'],
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.stderr.trim()).toBe('erreur');
  });

  it('respecte le timeout (SIGKILL)', async () => {
    const r = await runBinary({
      bin: 'sleep',
      args: ['10'],
      timeoutMs: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(2000);
  });

  it('passe stdin au process', async () => {
    const r = await runBinary({
      bin: 'cat',
      args: [],
      stdin: 'donnees a echo',
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('donnees a echo');
  });

  it('renvoie ok=false si binaire introuvable', async () => {
    const r = await runBinary({ bin: '/usr/bin/binaire-qui-existe-pas-xyz', args: [] });
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/spawn|ENOENT|not found/i);
  });

  it('tronque le stdout si depasse maxBufferBytes', async () => {
    const r = await runBinary({
      bin: 'sh',
      args: ['-c', 'yes a | head -c 5000'],
      maxBufferBytes: 100,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout.length).toBeLessThan(200);
    expect(r.stdout).toMatch(/truncated/);
  });
});
