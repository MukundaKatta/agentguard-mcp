#!/usr/bin/env node
/**
 * agentguard MCP server.
 *
 * Exposes three tools that wrap @mukundakatta/agentguard's policy engine:
 *
 *   check_url           — single URL check against a network policy
 *   check_urls_batch    — batch URL check
 *   validate_policy     — sanity-check a policy spec and host patterns
 *
 * Configure your client to spawn this binary over stdio. Example for Claude Desktop's
 * `claude_desktop_config.json`:
 *
 *   {
 *     "mcpServers": {
 *       "agentguard": {
 *         "command": "npx",
 *         "args": ["-y", "@mukundakatta/agentguard-mcp"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { policy, check, VERSION } from '@mukundakatta/agentguard';

const server = new Server(
  {
    name: 'agentguard',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// --- tool catalog ---------------------------------------------------------

const POLICY_SCHEMA = {
  type: 'object',
  description:
    'A simplified network policy. Use { allow: ["api.openai.com", "*.example.com"] }. ' +
    'Optional: deny: string[], methods: string[].',
  properties: {
    allow: {
      type: 'array',
      items: { type: 'string' },
      description: 'Host patterns to allow. Supports exact and *.suffix wildcards.',
    },
    deny: {
      type: 'array',
      items: { type: 'string' },
      description: 'Host patterns to deny. Wins over allow.',
    },
    methods: {
      type: 'array',
      items: { type: 'string' },
      description: 'HTTP methods to permit (e.g. ["GET", "POST"]). Default any.',
    },
  },
} as const;

const TOOLS = [
  {
    name: 'check_url',
    description:
      'Check whether a URL is allowed under a network policy. Returns { allowed, reason } without making any actual request. Use this to gate tool calls before they execute.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to check.' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        policy: POLICY_SCHEMA,
      },
      required: ['url', 'policy'],
    },
  },
  {
    name: 'check_urls_batch',
    description:
      'Batch-check multiple URLs against the same policy. Returns per-URL decisions plus an allowed/denied summary. Useful for vetting a list of pending tool fetches.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'URLs to check.',
        },
        method: { type: 'string', description: 'HTTP method applied to all URLs.' },
        policy: POLICY_SCHEMA,
      },
      required: ['urls', 'policy'],
    },
  },
  {
    name: 'validate_policy',
    description:
      'Sanity-check a policy spec without making any decision. Catches: empty allow list, overly broad "*" wildcards, malformed host patterns containing schemes/paths/queries.',
    inputSchema: {
      type: 'object',
      properties: {
        policy: POLICY_SCHEMA,
      },
      required: ['policy'],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// --- tool dispatch --------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case 'check_url':
        return checkUrlTool(args as { url: string; method?: string; policy: any });
      case 'check_urls_batch':
        return checkUrlsBatchTool(args as { urls: string[]; method?: string; policy: any });
      case 'validate_policy':
        return validatePolicyTool(args as { policy: any });
      default:
        return errorResult('unknown tool: ' + name);
    }
  } catch (err) {
    return errorResult('internal error: ' + (err as Error).message);
  }
});

// --- tool implementations -------------------------------------------------

function buildPolicy(p: any) {
  // Accept the simplified shape and translate to agentguard's structure.
  return policy({
    network: {
      allow: p.allow,
      deny: p.deny,
      methods: p.methods,
    },
  });
}

function checkUrlTool(args: { url: string; method?: string; policy: any }) {
  const pol = buildPolicy(args.policy);
  const decision = check(pol, args.url, args.method ? { method: args.method } : undefined);
  const allowed = decision.action === 'allow';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            allowed,
            reason: allowed ? 'matched_allowlist' : (decision as any).reason,
            detail: allowed ? null : (decision as any).detail,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function checkUrlsBatchTool(args: { urls: string[]; method?: string; policy: any }) {
  const pol = buildPolicy(args.policy);
  const init = args.method ? { method: args.method } : undefined;
  const results = args.urls.map((url) => {
    const decision = check(pol, url, init);
    const allowed = decision.action === 'allow';
    return {
      url,
      allowed,
      reason: allowed ? 'matched_allowlist' : (decision as any).reason,
      detail: allowed ? null : (decision as any).detail,
    };
  });
  const allowed_count = results.filter((r) => r.allowed).length;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            results,
            summary: {
              total: results.length,
              allowed_count,
              denied_count: results.length - allowed_count,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

function validatePolicyTool(args: { policy: any }) {
  const issues: string[] = [];
  const allow = args.policy?.allow;
  const deny = args.policy?.deny;

  if (!Array.isArray(allow) || allow.length === 0) {
    issues.push('allow list is empty or missing — every request will be denied');
  }
  for (const p of allow ?? []) {
    if (typeof p !== 'string') {
      issues.push(`non-string entry in allow: ${JSON.stringify(p)}`);
      continue;
    }
    if (p === '*') issues.push(`pattern "*" matches every host — equivalent to no firewall`);
    if (p.includes('://')) issues.push(`pattern "${p}" includes a scheme; use bare host (e.g. "api.example.com")`);
    if (p.includes('/')) issues.push(`pattern "${p}" includes a path; agentguard matches host only`);
    if (p.includes('?')) issues.push(`pattern "${p}" includes a query; agentguard matches host only`);
  }
  for (const p of deny ?? []) {
    if (typeof p !== 'string') {
      issues.push(`non-string entry in deny: ${JSON.stringify(p)}`);
    }
  }

  // Try to actually build the policy — catches structural errors.
  let valid = issues.length === 0;
  try {
    buildPolicy(args.policy);
  } catch (e) {
    valid = false;
    issues.push('policy() rejected the spec: ' + (e as Error).message);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ valid, issues }, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// --- bootstrap ------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(`agentguard MCP server v0.1.0 (agentguard ${VERSION}) ready on stdio\n`);
