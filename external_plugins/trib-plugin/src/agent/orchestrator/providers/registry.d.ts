import type { Provider, ProvidersConfig } from './base.js';
export declare function initProviders(config: ProvidersConfig): Promise<void>;
export declare function getProvider(name: string): Provider | undefined;
export declare function getAllProviders(): Map<string, Provider>;
export declare function listProviderNames(): string[];
