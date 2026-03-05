import axios from 'axios';
import type { ApsToken } from './types';

const APS_AUTH_URL = 'https://developer.api.autodesk.com/authentication/v2/token';

let cachedToken: ApsToken | null = null;

export async function getApsToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.access_token;
  }

  const clientId = process.env.APS_CLIENT_ID;
  const clientSecret = process.env.APS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('APS_CLIENT_ID and APS_CLIENT_SECRET must be set in environment variables');
  }

  const scopes = ['data:read', 'data:write', 'bucket:read', 'viewables:read'];

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('grant_type', 'client_credentials');
  params.append('scope', scopes.join(' '));

  try {
    const response = await axios.post<Omit<ApsToken, 'expiresAt'>>(APS_AUTH_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    cachedToken = {
      ...response.data,
      expiresAt: now + response.data.expires_in * 1000,
    };

    console.log(`[APS Auth] Token acquired, expires in ${response.data.expires_in}s`);
    return cachedToken.access_token;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.errorMessage || error.message;
      throw new Error(`APS authentication failed: ${message}`);
    }
    throw error;
  }
}

export function clearTokenCache(): void {
  cachedToken = null;
}
