import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ProvidersConfig } from './providers/base.js';

export interface Config {
  providers: ProvidersConfig;
}

const ENV_KEY_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
};

function buildDefaultConfig(): Config {
  const providers: ProvidersConfig = {};

  // API providers — enabled if env key exists
  for (const [name, envKey] of Object.entries(ENV_KEY_MAP)) {
    const apiKey = process.env[envKey];
    providers[name] = {
      enabled: !!apiKey,
      apiKey: apiKey || undefined,
    };
  }

  // Copilot — enabled if GITHUB_TOKEN or hosts.json exists
  providers.copilot = {
    enabled: !!process.env.GITHUB_TOKEN,
    baseURL: 'https://api.githubcopilot.com',
  };

  // Local providers — enabled by default (will fail gracefully if not running)
  providers.ollama = { enabled: true, baseURL: 'http://localhost:11434/v1' };
  providers.lmstudio = { enabled: false, baseURL: 'http://localhost:1234/v1' };

  return { providers };
}

export function loadConfig(): Config {
  // Try config file first
  const configPaths = [
    join(process.cwd(), 'trib-orchestrator.json'),
    join(homedir(), '.config', 'trib-orchestrator', 'config.json'),
    join(homedir(), '.trib-orchestrator.json'),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<Config>;
        const defaults = buildDefaultConfig();

        // Merge: file config overrides env defaults
        return {
          providers: { ...defaults.providers, ...raw.providers },
        };
      } catch {
        // Fall through to defaults
      }
    }
  }

  return buildDefaultConfig();
}
