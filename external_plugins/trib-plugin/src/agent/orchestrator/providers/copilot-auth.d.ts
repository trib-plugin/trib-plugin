/**
 * Load GitHub OAuth token from standard locations.
 * Priority: GITHUB_TOKEN env → hosts.json → apps.json
 */
export declare function loadGitHubToken(): string | null;
/**
 * Exchange GitHub OAuth token for Copilot bearer token.
 * Caches the token until it expires.
 */
export declare function getCopilotBearerToken(): Promise<string | null>;
