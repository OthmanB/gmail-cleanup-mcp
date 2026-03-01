import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import YAML from 'yaml';

const AbsolutePathSchema = z.string().min(1).refine((p) => path.isAbsolute(p), {
  message: 'Must be an absolute path',
});

const ConfigSchema = z
  .object({
    config_version: z.literal(1),

    oauth: z
      .object({
        client_file_path: AbsolutePathSchema,
        token_file_path: AbsolutePathSchema,
        scopes: z.array(z.string().min(1)).min(1),
      })
      .strict(),

    gmail: z
      .object({
        user_id: z.string().min(1),
      })
      .strict(),

    paths: z
      .object({
        allowed_list_roots: z.array(AbsolutePathSchema).min(1),
      })
      .strict(),

    cleanup: z
      .object({
        mode: z.literal('trash'),
        default_query_suffix: z.string(),
        max_entries: z.number().int().positive(),
        max_list_bytes: z.number().int().positive(),
        unsubscribe_probe_messages: z.number().int().positive(),
        global_max_messages: z.number().int().positive(),
        per_entry_max_messages: z.number().int().positive(),
        sample_per_entry: z.number().int().positive(),
        batch_size: z.number().int().positive().max(1000),
        plan_ttl_seconds: z.number().int().positive(),
        rate_limit: z
          .object({
            min_delay_ms: z.number().int().nonnegative(),
            max_retries: z.number().int().nonnegative(),
            backoff_base_ms: z.number().int().positive(),
            backoff_max_ms: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),

    unsubscribe: z
      .object({
        enabled: z.boolean(),
        max_links_per_entry: z.number().int().positive(),
        request_timeout_ms: z.number().int().positive(),
        user_agent: z.string().min(1),
        mailto:
          z
            .object({
              enabled: z.boolean(),
              max_sends_per_entry: z.number().int().positive(),
              max_sends_per_run: z.number().int().positive(),
              subject_fallback: z.string(),
              body_fallback: z.string(),
              skip_if_http_succeeded: z.boolean(),
              validate_recipient_domain_dns: z.boolean(),
            })
            .strict(),
        http:
          z
            .object({
              allow_http: z.boolean(),
              one_click_post_body: z.string().min(1),
            })
            .strict(),
      })
      .strict(),

    output: z
      .object({
        metadata_headers: z.array(z.string().min(1)).min(1),
        snippet_max_length: z.number().int().positive(),
        max_unsubscribe_links_per_entry: z.number().int().positive(),
      })
      .strict(),

    logging: z
      .object({
        level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
      })
      .strict(),
  })
  .strict();

export type AppConfig = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: AppConfig;
  configPath: string;
  configHash: string;
}

export async function loadConfigFromFile(configPath: string): Promise<LoadedConfig> {
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  const config = ConfigSchema.parse(parsed);

  if (config.unsubscribe.enabled && config.unsubscribe.mailto.enabled) {
    const hasGmailSendScope = config.oauth.scopes.includes('https://www.googleapis.com/auth/gmail.send');
    if (!hasGmailSendScope) {
      throw new Error(
        'Config error: unsubscribe.mailto.enabled=true requires oauth.scopes to include https://www.googleapis.com/auth/gmail.send'
      );
    }
  }

  // Fail fast on common misconfigurations.
  await assertReadableFile(config.oauth.client_file_path, 'oauth.client_file_path');
  // token_file_path is expected to be created by the auth bootstrap; it may not exist yet.
  await assertWritableParentDir(config.oauth.token_file_path, 'oauth.token_file_path');

  for (const root of config.paths.allowed_list_roots) {
    await assertReadableDir(root, 'paths.allowed_list_roots');
  }

  const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  return { config, configPath, configHash };
}

export function resolveDefaultConfigPath(cwd: string): string {
  return path.join(cwd, 'config', 'config.yaml');
}

async function assertReadableFile(filePath: string, keyName: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('Path is not a file');
    }
    await fs.access(filePath, fsConstants.R_OK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Config error: ${keyName} must be a readable file. path=${filePath} err=${msg}`);
  }
}

async function assertReadableDir(dirPath: string, keyName: string): Promise<void> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      throw new Error('Path is not a directory');
    }
    await fs.access(dirPath, fsConstants.R_OK | fsConstants.X_OK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Config error: ${keyName} must contain readable directories. dir=${dirPath} err=${msg}`);
  }
}

async function assertWritableParentDir(filePath: string, keyName: string): Promise<void> {
  const parent = path.dirname(filePath);
  try {
    const stat = await fs.stat(parent);
    if (!stat.isDirectory()) {
      throw new Error('Parent path is not a directory');
    }
    await fs.access(parent, fsConstants.W_OK | fsConstants.X_OK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Config error: parent directory for ${keyName} must exist and be accessible. parent=${parent} err=${msg}`);
  }
}
