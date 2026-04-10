import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(currentDir, '..')

// Unified mode: search uses its own data dir, not the shared CLAUDE_PLUGIN_DATA
const SEARCH_DATA_DIR = path.join(os.homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin')
export const DATA_DIR = fs.existsSync(SEARCH_DATA_DIR) ? SEARCH_DATA_DIR
  : (process.env.CLAUDE_PLUGIN_DATA || path.join(PLUGIN_ROOT, '.trib-search-data'))
export const CONFIG_PATH = path.join(DATA_DIR, 'search-config.json')
export const USAGE_PATH = path.join(DATA_DIR, 'usage.local.json')
export const CACHE_PATH = path.join(DATA_DIR, 'cache.local.json')
export const CLI_HOME_DIR = path.join(DATA_DIR, 'cli-home')

export const DEFAULT_CONFIG = {
  rawSearch: {
    priority: ['serper', 'brave', 'perplexity', 'firecrawl', 'tavily', 'xai'],
    maxResults: 10,
    credentials: {
      serper: {
        apiKey: '',
      },
      brave: {
        apiKey: '',
      },
      perplexity: {
        apiKey: '',
      },
      firecrawl: {
        apiKey: '',
      },
      tavily: {
        apiKey: '',
      },
      xai: {
        apiKey: '',
      },
      github: {
        token: '',
      },
    },
  },
  aiSearch: {
    priority: ['codex', 'claude', 'grok', 'gemini'],
    timeoutMs: 60000,
    profiles: {
      grok: {
        connection: 'api',
        apiKey: '',
        model: 'grok-4.20-0309-reasoning',
        xSearchEnabled: true,
      },
      gemini: {
        connection: 'cli',
        model: 'gemini-2.5-pro',
      },
      claude: {
        connection: 'cli',
        model: 'sonnet',
        effort: 'medium',
        fastMode: false,
      },
      codex: {
        connection: 'cli',
        model: 'gpt-5.4',
        effort: 'xhigh',
        fastMode: true,
      },
    },
  },
  requestTimeoutMs: 15000,
  crawl: {
    maxPages: 10,
    maxDepth: 2,
    sameDomainOnly: true,
  },
  siteRules: {
    'x.com': {
      search: 'xai.x_search',
      scrape: 'xai.x_search',
    },
  },
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

export function ensureDataDir() {
  ensureDir(DATA_DIR)
  ensureDir(CLI_HOME_DIR)
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function normalizeLegacyConfig(config) {
  if (!config) return DEFAULT_CONFIG
  if (config.rawSearch || config.aiSearch || config.siteRules) {
    return config
  }

  return {
    rawSearch: {
      priority: config.rawProviders || DEFAULT_CONFIG.rawSearch.priority,
      maxResults: config.rawMaxResults || DEFAULT_CONFIG.rawSearch.maxResults,
      credentials: {
        ...DEFAULT_CONFIG.rawSearch.credentials,
        serper: {
          apiKey:
            config.serperApiKey ||
            DEFAULT_CONFIG.rawSearch.credentials.serper.apiKey,
        },
        brave: {
          apiKey:
            config.braveApiKey ||
            DEFAULT_CONFIG.rawSearch.credentials.brave.apiKey,
        },
        perplexity: {
          apiKey:
            config.perplexityApiKey ||
            DEFAULT_CONFIG.rawSearch.credentials.perplexity.apiKey,
        },
        firecrawl: {
          apiKey:
            config.firecrawlApiKey ||
            DEFAULT_CONFIG.rawSearch.credentials.firecrawl.apiKey,
        },
        tavily: {
          apiKey:
            config.tavilyApiKey ||
            DEFAULT_CONFIG.rawSearch.credentials.tavily.apiKey,
        },
        xai: {
          apiKey:
            config.xaiApiKey ||
            config.grokApiKey ||
            DEFAULT_CONFIG.rawSearch.credentials.xai.apiKey,
        },
      },
    },
    aiSearch: {
      priority:
        config.aiPriority ||
        (config.aiDefaultProvider
          ? [config.aiDefaultProvider, ...DEFAULT_CONFIG.aiSearch.priority.filter(item => item !== config.aiDefaultProvider)]
          : DEFAULT_CONFIG.aiSearch.priority),
      timeoutMs: config.aiTimeoutMs || DEFAULT_CONFIG.aiSearch.timeoutMs,
      profiles: {
        grok: {
          ...DEFAULT_CONFIG.aiSearch.profiles.grok,
          apiKey: config.grokApiKey || DEFAULT_CONFIG.aiSearch.profiles.grok.apiKey,
          model: config.aiModels?.grok || DEFAULT_CONFIG.aiSearch.profiles.grok.model,
        },
        gemini: {
          ...DEFAULT_CONFIG.aiSearch.profiles.gemini,
          model: config.aiModels?.gemini || DEFAULT_CONFIG.aiSearch.profiles.gemini.model,
        },
        claude: {
          ...DEFAULT_CONFIG.aiSearch.profiles.claude,
          model: config.aiModels?.claude || DEFAULT_CONFIG.aiSearch.profiles.claude.model,
        },
        codex: {
          ...DEFAULT_CONFIG.aiSearch.profiles.codex,
          model: config.aiModels?.codex || DEFAULT_CONFIG.aiSearch.profiles.codex.model,
        },
      },
    },
    requestTimeoutMs: config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs,
    crawl: {
      ...DEFAULT_CONFIG.crawl,
      ...(config.crawl || {}),
    },
    siteRules: DEFAULT_CONFIG.siteRules,
  }
}

export function loadConfig() {
  ensureDataDir()
  let config = readJson(CONFIG_PATH, null)
  // If config has a 'search' section, use it (unified config format)
  if (config && config.search && config.search.rawSearch) {
    config = config.search
  }
  if (!config) {
    writeJson(CONFIG_PATH, DEFAULT_CONFIG)
    process.stderr.write(
      `trib-search: default config created at ${CONFIG_PATH}\n` +
      '  use /setup to change provider priority and crawl defaults.\n',
    )
  }
  const resolved = normalizeLegacyConfig(config || DEFAULT_CONFIG)
  return {
    ...DEFAULT_CONFIG,
    ...resolved,
    rawSearch: {
      ...DEFAULT_CONFIG.rawSearch,
      ...(resolved?.rawSearch || {}),
      credentials: {
        ...DEFAULT_CONFIG.rawSearch.credentials,
        ...(resolved?.rawSearch?.credentials || {}),
      },
    },
    aiSearch: {
      ...DEFAULT_CONFIG.aiSearch,
      ...(resolved?.aiSearch || {}),
      profiles: {
        ...DEFAULT_CONFIG.aiSearch.profiles,
        ...(resolved?.aiSearch?.profiles || {}),
      },
    },
    crawl: {
      ...DEFAULT_CONFIG.crawl,
      ...(resolved?.crawl || {}),
    },
    siteRules: {
      ...DEFAULT_CONFIG.siteRules,
      ...(resolved?.siteRules || {}),
    },
  }
}

export function getRawSearchPriority(config) {
  return config.rawSearch?.priority || DEFAULT_CONFIG.rawSearch.priority
}

export function getRawSearchMaxResults(config) {
  return config.rawSearch?.maxResults || DEFAULT_CONFIG.rawSearch.maxResults
}

export function getRawProviderApiKey(config, provider) {
  const cred = config.rawSearch?.credentials?.[provider]
  if (provider === 'github') return cred?.token || ''
  return cred?.apiKey || ''
}

export function getRawProviderCredentialSource(config, provider, env = process.env) {
  if (getRawProviderApiKey(config, provider)) {
    return 'config'
  }

  const envKeyByProvider = {
    serper: 'SERPER_API_KEY',
    brave: 'BRAVE_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
    firecrawl: 'FIRECRAWL_API_KEY',
    tavily: 'TAVILY_API_KEY',
    xai: ['XAI_API_KEY', 'GROK_API_KEY'],
    github: 'GITHUB_TOKEN',
  }

  const envKey = envKeyByProvider[provider]
  if (envKey) {
    const keys = Array.isArray(envKey) ? envKey : [envKey]
    if (keys.some(k => env?.[k])) {
      return 'env'
    }
  }

  return null
}

export function getAiDefaultProvider(config) {
  const priority = config.aiSearch?.priority || DEFAULT_CONFIG.aiSearch.priority
  return Array.isArray(priority) && priority.length > 0
    ? priority[0]
    : DEFAULT_CONFIG.aiSearch.priority[0]
}

export function getAiSearchPriority(config) {
  return config.aiSearch?.priority || DEFAULT_CONFIG.aiSearch.priority
}

export function getAiTimeoutMs(config) {
  return config.aiSearch?.timeoutMs || DEFAULT_CONFIG.aiSearch.timeoutMs
}

export function getAiProfile(config, provider) {
  return config.aiSearch?.profiles?.[provider] || DEFAULT_CONFIG.aiSearch.profiles?.[provider] || {}
}

export function getSiteRule(config, site) {
  return config.siteRules?.[site] || null
}

export function getRequestTimeoutMs(config) {
  return config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs
}

export function getGrokApiKey(config) {
  return getAiProfile(config, 'grok').apiKey || ''
}

export function getFirecrawlApiKey(config) {
  return (
    getRawProviderApiKey(config, 'firecrawl') ||
    config.firecrawlApiKey ||
    ''
  )
}
