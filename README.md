# gmail-cleanup-mcp

Local MCP (Model Context Protocol) server for safe Gmail cleanup:

- Preview what will be removed (samples per sender/query)
- Attempt to unsubscribe (HTTP one-click/GET + `mailto:`)
- Move matching messages to Trash (recoverable)

This project is designed to be used from an MCP-capable client (e.g., OpenCode).

## What It Does

Tools exposed over MCP stdio:

- `preview_cleanup`
  - Input: sender/query list (file or inline text)
  - Output: per-entry match estimate (often capped/saturated), a small sample, and discovered unsubscribe hints
  - Returns a `planId` and `confirmPhrase`

- `execute_cleanup`
  - Requires: exact `planId` + `confirmPhrase`
  - For each entry: attempts unsubscribe first, then moves matching messages to Gmail Trash
  - Output: trash counts + unsubscribe stats (HTTP vs mailto) + a `manualRequired` queue when automation is ambiguous

There is no permanent delete in v1.

## Safety Model

- Two-step flow: `preview_cleanup` -> `execute_cleanup` (confirm phrase required)
- Default query suffix excludes spam and trash (`-in:spam -in:trash`)
- Caps and batching (global + per-entry)
- Sender list path allowlist (prevents reading arbitrary files)
- Secrets live outside git (commonly under `secrets/`, which is gitignored)

## Requirements

- Node.js >= 20
- A Google Cloud project with Gmail API enabled
- OAuth Desktop Client credentials

## Install

```bash
git clone <your-fork-or-repo-url>
cd gmail-cleanup-mcp
npm install
npm run build
```

## Configure (No Secrets In Git)

1) Download OAuth client JSON (Google Cloud Console) and store it locally.

Recommended:

- store it outside the repo, or
- store it under `secrets/` (gitignored)

2) Create your local config:

- Copy `config/config.example.yaml` to a local config file (recommended outside the repo).
  - If you keep it in-repo, use `config/config.yaml` (gitignored).
- Edit your config file and set absolute paths for:
  - `oauth.client_file_path`
  - `oauth.token_file_path`
  - `paths.allowed_list_roots`

You can store the config anywhere and point to it using either:

- CLI arg: `--config /absolute/path/to/config.yaml`
- Env var: `GMAIL_CLEANUP_MCP_CONFIG_PATH=/absolute/path/to/config.yaml`

Important:

- `config/*.yaml` is gitignored on purpose (except `config/config.example.yaml`).
- Never commit `secrets/`.

3) Bootstrap OAuth token:

```bash
npm run auth:bootstrap -- --config /absolute/path/to/config.yaml
```

Alternatively:

```bash
GMAIL_CLEANUP_MCP_CONFIG_PATH=/absolute/path/to/config.yaml npm run auth:bootstrap
```

This prints an authorization URL. After you authorize, a token is written to the path configured in `oauth.token_file_path`.

If you change scopes, delete the token file and re-run bootstrap.

## Sender List Format

Plain text file, one entry per line. Blank lines and `#` comments are ignored.

Accepted line forms:

- `user@example.com` -> `from:user@example.com`
- `@example.com` or `example.com` -> `from:example.com`
- Raw Gmail query (starts with `from:` / `subject:` / `has:` / etc.)

Examples:

```text
# emails
newsletter@example.com

# domain
@example.org

# raw Gmail query
from:"Sender Name" older_than:2y
subject:"sale" older_than:1y
```

See `lists/senders.example.txt`.

## Unsubscribe Automation Notes

`List-Unsubscribe` supports several schemes and not all can be fully automated.

- HTTP one-click (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`): attempted via POST (with GET fallback)
- HTTP GET links: attempted, but often still require manual confirmation/options; these are surfaced via `manualRequired`
- `mailto:` links: sent using Gmail API (`gmail.send` scope required)

Mailto safety notes:

- Mailto sends are capped.
- Mailto recipient domains can be DNS-validated to reduce bounce messages.
- Mailto sends can be skipped if an HTTP unsubscribe already succeeded for the entry.

Even with automation, some publishers use preference centers or confirmation steps.

## OpenCode (MCP) Configuration

Add a local MCP server to your OpenCode config (example):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gmail_cleanup": {
      "type": "local",
      "command": ["node", "dist/index.js", "--config", "/absolute/path/to/config.yaml"],
      "enabled": true,
      "environment": {}
    }
  }
}
```

Make sure the MCP server runs with cwd at the repo root so `dist/index.js` exists.

## CI

CI runs `npm ci`, `npm run test`, and `npm run build`.

## Publishing To GitHub Safely

Before you push:

- Confirm `secrets/` is not tracked and not staged.
- Confirm no local config files are tracked (e.g. `config/config.yaml`).

Recommended checks:

```bash
git status
git check-ignore -v secrets/ config/config.yaml || true
```

## License

MIT (see `LICENSE`).
