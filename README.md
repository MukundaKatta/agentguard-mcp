# agentguard-mcp

**MCP server for [`@mukundakatta/agentguard`](https://www.npmjs.com/package/@mukundakatta/agentguard).** Lets Claude Desktop, Cursor, Cline, Windsurf, Zed, or any other MCP client check whether a URL is allowed under a network-egress policy before any fetch.

```bash
npx -y @mukundakatta/agentguard-mcp
```

Three tools:

- **`check_url`** — single URL check: returns `{ allowed, reason }` without making any actual request.
- **`check_urls_batch`** — batch check with per-URL decisions plus a summary.
- **`validate_policy`** — sanity-check a policy spec for empty allowlists, overly broad `*` wildcards, and malformed host patterns.

## Add to your client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "agentguard": {
      "command": "npx",
      "args": ["-y", "@mukundakatta/agentguard-mcp"]
    }
  }
}
```

Same shape for Cursor (`~/.cursor/mcp.json`), Cline, Windsurf, Zed.

## Tool examples

**`check_url`:**

```json
{
  "url": "https://api.openai.com/v1/chat",
  "policy": { "allow": ["api.openai.com", "*.anthropic.com"] }
}
```

Returns:

```json
{ "allowed": true, "reason": "matched_allowlist", "detail": null }
```

**`check_urls_batch`:**

```json
{
  "urls": [
    "https://api.openai.com/v1/chat",
    "https://evil.example.com/leak"
  ],
  "policy": { "allow": ["api.openai.com"] }
}
```

Returns:

```json
{
  "results": [
    { "url": "https://api.openai.com/v1/chat", "allowed": true, ... },
    { "url": "https://evil.example.com/leak", "allowed": false, "reason": "not_in_allowlist", ... }
  ],
  "summary": { "total": 2, "allowed_count": 1, "denied_count": 1 }
}
```

**`validate_policy`:**

```json
{ "policy": { "allow": ["*", "https://api.example.com", "api.example.com/v1"] } }
```

Returns issues for the `*` wildcard, the scheme prefix, and the path suffix — common mistakes when first writing a policy.

## Why a separate MCP server

`@mukundakatta/agentguard` is a zero-dependency JavaScript library. This MCP server makes its decision engine accessible from any MCP-aware AI assistant: ask Claude "does my agent's tool list pass this firewall?" or "which of these 50 URLs would my policy block?" and the assistant calls these tools directly.

Note: this MCP server only **checks** URLs — it does not actually wrap fetch or block real requests. For runtime enforcement, use `@mukundakatta/agentguard` directly inside your Node process.

## Sibling MCP servers

Part of the agent-stack series:

- [`@mukundakatta/agentfit-mcp`](https://www.npmjs.com/package/@mukundakatta/agentfit-mcp) — *Fit it.*
- [`@mukundakatta/agentguard-mcp`](https://www.npmjs.com/package/@mukundakatta/agentguard-mcp) — *Sandbox it.* (this)
- [`@mukundakatta/agentsnap-mcp`](https://www.npmjs.com/package/@mukundakatta/agentsnap-mcp) — *Test it.*
- [`@mukundakatta/agentvet-mcp`](https://www.npmjs.com/package/@mukundakatta/agentvet-mcp) — *Vet it.*
- [`@mukundakatta/agentcast-mcp`](https://www.npmjs.com/package/@mukundakatta/agentcast-mcp) — *Validate it.*

## License

MIT
