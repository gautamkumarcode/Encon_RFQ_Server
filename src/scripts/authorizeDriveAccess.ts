/**
 * One-time Google Drive OAuth authorization for full RFQ folder management.
 *
 * Register this exact redirect URI in the Google Cloud OAuth client first:
 *   http://127.0.0.1:53682/oauth2callback
 *
 * Then run:
 *   npm run drive:authorize
 *
 * The new refresh token is saved to the local .env file. Deployed environments
 * must receive the same GDRIVE_OAUTH_REFRESH_TOKEN value through their own
 * environment-variable settings.
 */
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { OAuth2Client } from 'google-auth-library';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
axios.defaults.timeout = 30000;

const FULL_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const ENV_PATH = path.resolve(__dirname, '../../.env');
const PORT = Number(process.env.GDRIVE_OAUTH_LOCAL_PORT || 53682);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The URL is printed below, so automatic browser opening is only a convenience.
  }
}

function saveRefreshToken(refreshToken: string): void {
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const line = `GDRIVE_OAUTH_REFRESH_TOKEN=${refreshToken}`;
  let updated: string;

  if (/^GDRIVE_OAUTH_REFRESH_TOKEN=.*$/m.test(current)) {
    updated = current.replace(/^GDRIVE_OAUTH_REFRESH_TOKEN=.*$/m, line);
  } else {
    updated = `${current}${current && !current.endsWith('\n') ? newline : ''}${line}${newline}`;
  }

  writeFileSync(ENV_PATH, updated, { encoding: 'utf8', mode: 0o600 });
}

function waitForAuthorizationCode(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('Authorization timed out after five minutes.'));
    }, 5 * 60 * 1000);

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const sendPage = (status: number, title: string, message: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body style="font-family:Arial,sans-serif;padding:32px"><h2>${title}</h2><p>${message}</p></body></html>`);
      };

      if (url.searchParams.get('error')) {
        sendPage(400, 'Google authorization failed', String(url.searchParams.get('error_description') || url.searchParams.get('error')));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(new Error('Google authorization was cancelled or denied.'));
        }
        return;
      }

      if (url.searchParams.get('state') !== state) {
        sendPage(400, 'Authorization state mismatch', 'Please run the authorization command again.');
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        sendPage(400, 'Missing authorization code', 'Please run the authorization command again.');
        return;
      }

      sendPage(200, 'Drive authorization received', 'You can close this tab and return to the terminal.');
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        server.close();
        resolve(code);
      }
    });

    server.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Waiting for Google authorization on ${REDIRECT_URI} ...`);
    });
  });
}

async function main(): Promise<void> {
  const clientId = (process.env.GDRIVE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GDRIVE_OAUTH_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('GDRIVE_OAUTH_CLIENT_ID and GDRIVE_OAUTH_CLIENT_SECRET must be configured in .env.');
  }

  console.log('Required OAuth scope:', FULL_DRIVE_SCOPE);
  console.log(`Ensure this redirect URI is registered on the OAuth client: ${REDIRECT_URI}`);

  const state = randomBytes(32).toString('hex');
  const oauthClient = new OAuth2Client({ clientId, clientSecret, redirectUri: REDIRECT_URI });
  const authorizationUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [FULL_DRIVE_SCOPE],
    state,
  });

  openBrowser(authorizationUrl);
  console.log('\nIf the browser did not open, use this URL:\n');
  console.log(authorizationUrl);

  const code = await waitForAuthorizationCode(state);
  const tokens = await oauthClient.getToken(code);
  const refreshToken = tokens.tokens.refresh_token;
  if (!refreshToken) {
    throw new Error('Google did not return a refresh token. Run the command again and approve access.');
  }

  const tokenInfo = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
    params: { access_token: tokens.tokens.access_token },
  });
  const scopes = new Set(String(tokenInfo.data.scope || '').split(/\s+/).filter(Boolean));
  if (!scopes.has(FULL_DRIVE_SCOPE)) {
    throw new Error('The returned OAuth token does not include the required full Drive scope.');
  }

  saveRefreshToken(refreshToken);
  console.log('\nFull Drive scope confirmed. GDRIVE_OAUTH_REFRESH_TOKEN was updated in the local .env.');
  console.log('If the backend is deployed, update that environment variable in the deployed backend too.');
  if (process.argv.includes('--print-token')) {
    console.log(`GDRIVE_OAUTH_REFRESH_TOKEN=${refreshToken}`);
  }
  console.log('\nNext, run: npm run drive:reconcile -- --apply');
}

main().catch((error: any) => {
  console.error('Drive authorization failed:', error.response?.data || error.message || error);
  process.exitCode = 1;
});
