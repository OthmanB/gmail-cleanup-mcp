import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs/promises';
import { loadConfigFromFile } from '../config.js';
import { createLogger } from '../logger.js';
import { createOAuth2ClientFromClientFile } from '../gmail/oauth.js';
import { resolveConfigPath } from '../config_path.js';

async function main(): Promise<void> {
  const cwd = process.cwd();
  const configPath = resolveConfigPath({ cwd, argv: process.argv, env: process.env });

  const { config } = await loadConfigFromFile(configPath);
  const logger = createLogger(config);

  const tokenExists = await fileExists(config.oauth.token_file_path);
  if (tokenExists) {
    throw new Error(
      `Token file already exists. Delete it if you want to re-auth. token_file_path=${config.oauth.token_file_path}`
    );
  }

  const callbackServer = await startOAuthCallbackServer({ logger });
  const oauth2Client = await createOAuth2ClientFromClientFile({
    clientFilePath: config.oauth.client_file_path,
    redirectUri: callbackServer.redirectUri,
  });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: config.oauth.scopes,
    prompt: 'consent',
  });

  logger.info(
    {
      op: 'auth.bootstrap.open_url',
      authUrl,
    },
    'Open this URL in a browser to authorize Gmail Cleanup MCP'
  );

  let code: string;
  try {
    code = await callbackServer.waitForCode();
  } finally {
    await callbackServer.close();
  }

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  await fs.writeFile(config.oauth.token_file_path, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });

  logger.info({ op: 'auth.bootstrap.saved', token_file_path: config.oauth.token_file_path }, 'OAuth token saved');
  if (!tokens.refresh_token) {
    logger.warn(
      { op: 'auth.bootstrap.no_refresh_token' },
      'No refresh_token was returned; you may need to remove app access and re-run with consent'
    );
  }
}

async function startOAuthCallbackServer(params: {
  logger: ReturnType<typeof createLogger>;
}): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  const server = http.createServer();

  const codePromise = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      try {
        if (!req.url) {
          res.statusCode = 400;
          res.end('Missing URL');
          return;
        }

        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/oauth2callback') {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          res.statusCode = 400;
          res.end('Authorization denied. You can close this tab.');
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          res.statusCode = 400;
          res.end('Missing code. You can close this tab.');
          reject(new Error('Missing OAuth code'));
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Authorization complete. You can close this tab and return to the terminal.');
        resolve(code);
      } catch (err) {
        res.statusCode = 500;
        res.end('Internal error');
        reject(err);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind local server for OAuth callback');
  }

  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  params.logger.info(
    { op: 'auth.bootstrap.redirect', redirectUri },
    'Local OAuth redirect server started'
  );

  return {
    redirectUri,
    waitForCode: () => codePromise,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
