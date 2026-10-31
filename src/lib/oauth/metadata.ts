// Discovery documents (RFC 9728 protected resource, RFC 8414 authorization server).
import { SCOPE } from "./store";

/** Base URL without trailing slash: PUBLIC_BASE_URL when set, else the request origin. */
export function resolveBaseUrl(publicBaseUrl: string | undefined | null, requestUrl: string): string {
  const raw = publicBaseUrl?.trim();
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      /* fall through */
    }
  }
  return new URL(requestUrl).origin;
}

export const mcpResourceUrl = (base: string) => `${base}/api/mcp`;

export function protectedResourceMetadata(base: string) {
  return {
    resource: mcpResourceUrl(base),
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
}
