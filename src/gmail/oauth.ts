import fs from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import type { Logger } from 'pino';

export interface OAuthParams {
  clientFilePath: string;
  tokenFilePath: string;
  scopes: string[];
}

interface OAuthClientJson {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

export async function createOAuth2ClientFromClientFile(params: {
  clientFilePath: string;
  redirectUri?: string;
}): Promise<OAuth2Client> {
  const raw = await fs.readFile(params.clientFilePath, 'utf8');
  const json = JSON.parse(raw) as OAuthClientJson;
  const section = json.installed ?? json.web;
  if (!section) {
    throw new Error('OAuth client JSON must contain "installed" or "web" section');
  }
  if (!section.client_id || !section.client_secret) {
    throw new Error('OAuth client JSON missing client_id/client_secret');
  }
  if (!Array.isArray(section.redirect_uris) || section.redirect_uris.length === 0) {
    throw new Error('OAuth client JSON missing redirect_uris');
  }

  const redirectUri = params.redirectUri ?? section.redirect_uris[0];
  return new OAuth2Client(section.client_id, section.client_secret, redirectUri);
}

export async function getAuthorizedOAuth2Client(params: OAuthParams, logger: Logger): Promise<OAuth2Client> {
  const oauth2Client = await createOAuth2ClientFromClientFile({
    clientFilePath: params.clientFilePath,
  });

  const tokenRaw = await readTokenFile(params.tokenFilePath);
  oauth2Client.setCredentials(tokenRaw);

  await assertTokenHasRequiredScopes({ oauth2Client, requiredScopes: params.scopes });

  oauth2Client.on('tokens', async (tokens) => {
    // Persist updated tokens (e.g., refreshed access_token). Never log token contents.
    try {
      const current = oauth2Client.credentials;
      const merged = { ...current, ...tokens };
      await writeTokenFile(params.tokenFilePath, merged);
      logger.debug({ op: 'oauth.tokens.persisted' }, 'OAuth tokens persisted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ op: 'oauth.tokens.persist_failed', err: msg }, 'Failed to persist OAuth tokens');
    }
  });

  logger.debug({ op: 'oauth.scopes.validated', scopes: params.scopes }, 'OAuth scopes validated');

  return oauth2Client;
}

async function assertTokenHasRequiredScopes(params: {
  oauth2Client: OAuth2Client;
  requiredScopes: string[];
}): Promise<void> {
  const accessTokenResult = await params.oauth2Client.getAccessToken();
  const accessToken = accessTokenResult.token;
  if (!accessToken) {
    throw new Error('OAuth access token is unavailable. Re-run auth bootstrap to refresh credentials.');
  }

  const tokenInfo = await params.oauth2Client.getTokenInfo(accessToken);
  const grantedScopes = new Set(normalizeScopes(tokenInfo.scopes));
  const missing = params.requiredScopes.filter((scope) => !grantedScopes.has(scope));
  if (missing.length > 0) {
    throw new Error(
      `OAuth token is missing required scopes. missing=${missing.join(',')} granted=${Array.from(grantedScopes).join(',')}`
    );
  }
}

function normalizeScopes(scopes: string[] | string | undefined): string[] {
  if (!scopes) return [];
  if (Array.isArray(scopes)) return scopes;
  return scopes
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function readTokenFile(tokenFilePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(tokenFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OAuth token file is missing/unreadable. Run auth bootstrap first. token_file_path=${tokenFilePath} err=${msg}`
    );
  }
}

async function writeTokenFile(tokenFilePath: string, token: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify(token, null, 2);
  await fs.writeFile(tokenFilePath, raw, { mode: 0o600 });
}
