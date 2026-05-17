import { describe, it, expect } from 'vitest';
import {
  offloadToolOutput,
  renderOffloadEnvelope,
  InMemoryOffloadStorage,
} from '../src/tools/toolOutputOffload';

describe('offloadToolOutput', () => {
  it('passes through content under the threshold', async () => {
    const storage = new InMemoryOffloadStorage();
    const env = await offloadToolOutput({
      content: 'small payload',
      runId: 'r1',
      toolName: 'echo',
      storage,
    });
    expect(env.offloaded).toBe(false);
    expect(env.head).toBe('small payload');
    expect(env.droppedTokens).toBe(0);
    expect(storage.size()).toBe(0);
  });

  it('offloads when content exceeds threshold', async () => {
    const storage = new InMemoryOffloadStorage();
    const content = 'x'.repeat(10_000); // ~2500 tokens
    const env = await offloadToolOutput({
      content,
      runId: 'run-42',
      toolName: 'fetch',
      storage,
      thresholdTokens: 2000,
      headChars: 200,
      tailChars: 100,
    });

    expect(env.offloaded).toBe(true);
    expect(env.head.length).toBe(200);
    expect(env.tail.length).toBe(100);
    expect(env.fullBytes).toBe(10_000);
    expect(env.droppedTokens).toBeGreaterThan(0);
    expect(env.ref).toMatch(/^mem:\/\/run-42\/fetch\//);
    expect(storage.size()).toBe(1);
    expect(storage.read(env.ref!)).toBe(content);
  });

  it('does not offload when head+tail already cover the body', async () => {
    const storage = new InMemoryOffloadStorage();
    const content = 'y'.repeat(9_000); // 2250 tokens > threshold
    const env = await offloadToolOutput({
      content,
      runId: 'r',
      toolName: 't',
      storage,
      thresholdTokens: 2000,
      headChars: 6000,
      tailChars: 4000, // 10k > content length
    });
    expect(env.offloaded).toBe(false);
    expect(storage.size()).toBe(0);
  });

  it('renderOffloadEnvelope produces an elision marker', async () => {
    const storage = new InMemoryOffloadStorage();
    const content = 'z'.repeat(20_000);
    const env = await offloadToolOutput({
      content,
      runId: 'r',
      toolName: 't',
      storage,
      thresholdTokens: 2000,
    });
    const rendered = renderOffloadEnvelope(env);
    expect(rendered.startsWith(env.head)).toBe(true);
    expect(rendered.endsWith(env.tail)).toBe(true);
    expect(rendered).toContain('tokens elided');
    expect(rendered).toContain(env.ref!);
  });

  it('renderOffloadEnvelope returns head unchanged when not offloaded', async () => {
    const storage = new InMemoryOffloadStorage();
    const env = await offloadToolOutput({
      content: 'hi',
      runId: 'r',
      toolName: 't',
      storage,
    });
    expect(renderOffloadEnvelope(env)).toBe('hi');
  });

  it('produces stable hashes for identical content', async () => {
    const storage = new InMemoryOffloadStorage();
    const content = 'a'.repeat(10_000);
    const a = await offloadToolOutput({ content, runId: 'r', toolName: 't', storage });
    const b = await offloadToolOutput({ content, runId: 'r', toolName: 't', storage });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.ref).toBe(b.ref);
  });
});
