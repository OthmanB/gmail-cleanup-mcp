import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { loadConfigFromFile } from './config.js';
import { resolveConfigPath } from './config_path.js';
import { createLogger } from './logger.js';
import { getAuthorizedOAuth2Client } from './gmail/oauth.js';
import { GmailClient } from './gmail/gmail_client.js';
import { PlanStore } from './plan_store.js';
import {
  PreviewCleanupInputSchema,
  previewCleanup,
} from './tools/preview_cleanup.js';
import {
  ExecuteCleanupInputSchema,
  executeCleanup,
} from './tools/execute_cleanup.js';

async function main(): Promise<void> {
  const cwd = process.cwd();
  const configPath = resolveConfigPath({ cwd, argv: process.argv, env: process.env });

  const { config, configHash } = await loadConfigFromFile(configPath);
  const logger = createLogger(config);

  logger.info({ op: 'startup', configPath }, 'Starting Gmail Cleanup MCP');

  const auth = await getAuthorizedOAuth2Client(
    {
      clientFilePath: config.oauth.client_file_path,
      tokenFilePath: config.oauth.token_file_path,
      scopes: config.oauth.scopes,
    },
    logger
  );

  const gmail = new GmailClient(
    auth,
    {
      userId: config.gmail.user_id,
      retry: {
        maxRetries: config.cleanup.rate_limit.max_retries,
        backoffBaseMs: config.cleanup.rate_limit.backoff_base_ms,
        backoffMaxMs: config.cleanup.rate_limit.backoff_max_ms,
        minDelayMs: config.cleanup.rate_limit.min_delay_ms,
      },
    },
    logger
  );

  const planStore = new PlanStore();

  const server = new Server(
    {
      name: 'gmail-cleanup-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'preview_cleanup',
          description:
            'Preview a cleanup plan from a sender/query list: counts + small samples per entry + unsubscribe hints. Returns planId + confirmPhrase.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'Absolute path to a sender list file (must be under allowed_list_roots)',
              },
              listText: {
                type: 'string',
                description: 'Inline sender list text (one entry per line)',
              },
              samplePerEntry: {
                type: 'integer',
                minimum: 1,
                description: 'Number of sample messages to return per entry (defaults to YAML config)',
              },
            },
          },
        },
        {
          name: 'execute_cleanup',
          description:
            'Execute a previously previewed cleanup plan by moving matched messages to Trash and attempting automatic unsubscribe for list-unsubscribe links. Requires exact confirmPhrase.',
          inputSchema: {
            type: 'object',
            properties: {
              planId: { type: 'string' },
              confirmPhrase: { type: 'string' },
              entryIndices: {
                type: 'array',
                items: { type: 'integer', minimum: 0 },
                description: 'Optional subset of entries to execute (by index)',
              },
              maxMessages: {
                type: 'integer',
                minimum: 1,
                description: 'Optional global cap override (cannot exceed YAML config cap)',
              },
              perEntryMaxMessages: {
                type: 'integer',
                minimum: 1,
                description: 'Optional per-entry cap override (cannot exceed YAML config cap)',
              },
            },
            required: ['planId', 'confirmPhrase'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'preview_cleanup') {
        const input = PreviewCleanupInputSchema.parse(args ?? {});
        const result = await previewCleanup({
          input,
          config,
          configHash,
          logger,
          gmail,
          planStore,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      }

      if (name === 'execute_cleanup') {
        const input = ExecuteCleanupInputSchema.parse(args ?? {});
        const result = await executeCleanup({
          input,
          config,
          configHash,
          logger,
          gmail,
          planStore,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (err instanceof z.ZodError) {
        throw new McpError(ErrorCode.InvalidParams, err.message);
      }

      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ op: 'tool.error', tool: name, err: msg }, 'Tool execution failed');
      throw new McpError(ErrorCode.InternalError, msg);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ op: 'startup.ready' }, 'Gmail Cleanup MCP running on stdio');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
