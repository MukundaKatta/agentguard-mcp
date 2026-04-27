/**
 * End-to-end smoke test: spawn the MCP server, ask for the tool catalog, and call
 * each tool with a representative input. Validates wire-level shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'src', 'server.ts');

function rpc(child: ReturnType<typeof spawn>, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if ('id' in msg && (msg as { id: number }).id === (request as { id: number }).id) {
            child.stdout?.off('data', onData);
            resolve(msg);
            return;
          }
        } catch {
          // partial line, keep buffering
        }
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', reject);
    child.stdin?.write(JSON.stringify(request) + '\n');
  });
}

async function withServer(fn: (child: ReturnType<typeof spawn>) => Promise<void>) {
  const child = spawn('npx', ['tsx', SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  await rpc(child, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    },
  });
  child.stdin?.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
  );
  try {
    await fn(child);
  } finally {
    child.kill();
  }
}

test('server lists three tools', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })) as { result: { tools: Array<{ name: string }> } };
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['check_url', 'check_urls_batch', 'validate_policy']);
  });
});

test('check_url allows hosts on the allowlist', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'check_url',
        arguments: {
          url: 'https://api.openai.com/v1/chat',
          policy: { allow: ['api.openai.com', '*.anthropic.com'] },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as { allowed: boolean };
    assert.equal(payload.allowed, true);
  });
});

test('check_url denies hosts off the allowlist', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'check_url',
        arguments: {
          url: 'https://evil.example.com/leak',
          policy: { allow: ['api.openai.com'] },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as { allowed: boolean };
    assert.equal(payload.allowed, false);
  });
});

test('check_urls_batch returns a per-url decision and summary', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'check_urls_batch',
        arguments: {
          urls: [
            'https://api.openai.com/v1/chat',
            'https://evil.example.com/leak',
            'https://api.anthropic.com/v1/messages',
          ],
          policy: { allow: ['api.openai.com', '*.anthropic.com'] },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      results: { allowed: boolean }[];
      summary: { allowed_count: number; denied_count: number };
    };
    assert.equal(payload.results.length, 3);
    assert.equal(payload.summary.allowed_count, 2);
    assert.equal(payload.summary.denied_count, 1);
  });
});

test('validate_policy flags overly broad and malformed patterns', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'validate_policy',
        arguments: {
          policy: { allow: ['*', 'https://api.example.com', 'api.example.com/v1'] },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      valid: boolean;
      issues: string[];
    };
    assert.equal(payload.valid, false);
    assert.ok(payload.issues.some((i) => i.includes('"*"')));
    assert.ok(payload.issues.some((i) => i.includes('scheme')));
    assert.ok(payload.issues.some((i) => i.includes('path')));
  });
});
