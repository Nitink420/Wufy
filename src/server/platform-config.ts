import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';

// `copilotkit project select` writes the CLI name and deletes the template name.
const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function intelligenceApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, INTELLIGENCE_API_KEY_ENV_NAMES);
}

export function intelligenceWsUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, [
    'INTELLIGENCE_GATEWAY_WS_URL',
    'INTELLIGENCE_WS_URL',
  ]);
}

export function agentRunTimeoutMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AGENT_RUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)
    throw new Error(
      `AGENT_RUN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  return value;
}

export interface AiConfig {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  provider: 'gemini' | 'nemotron' | 'openai';
}

export function resolveAiConfig(
  env: Record<string, string | undefined>,
): AiConfig {
  const provider = env.AI_PROVIDER?.trim().toLowerCase();

  // 1. Explicit or auto-detected Google Gemini
  if (
    provider === 'gemini' ||
    (!provider &&
      env.GEMINI_API_KEY?.trim() &&
      !env.NVIDIA_API_KEY?.trim() &&
      !env.OPENAI_API_KEY?.trim())
  ) {
    return {
      provider: 'gemini',
      apiKey: env.GEMINI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim(),
      baseUrl:
        env.GEMINI_BASE_URL?.trim() ||
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      model:
        env.GEMINI_MODEL?.trim() ||
        env.OPENAI_MODEL?.trim() ||
        'gemini-3.8-flash',
    };
  }

  // 2. Explicit or auto-detected NVIDIA Nemotron
  if (
    provider === 'nemotron' ||
    (!provider &&
      env.NVIDIA_API_KEY?.trim() &&
      !env.OPENAI_API_KEY?.trim())
  ) {
    return {
      provider: 'nemotron',
      apiKey: env.NVIDIA_API_KEY?.trim() || env.OPENAI_API_KEY?.trim(),
      baseUrl:
        env.NVIDIA_BASE_URL?.trim() || 'https://integrate.api.nvidia.com/v1',
      model:
        env.NVIDIA_MODEL?.trim() ||
        env.OPENAI_MODEL?.trim() ||
        'nvidia/nemotron-3.5-lightning-30b-a3b',
    };
  }

  // 3. OpenAI / OpenRouter or standard fallback
  return {
    provider: 'openai',
    apiKey:
      env.OPENAI_API_KEY?.trim() ||
      env.GEMINI_API_KEY?.trim() ||
      env.NVIDIA_API_KEY?.trim(),
    baseUrl:
      env.OPENAI_BASE_URL?.trim() ||
      (env.GEMINI_API_KEY?.trim()
        ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
        : env.NVIDIA_API_KEY?.trim()
          ? 'https://integrate.api.nvidia.com/v1'
          : 'https://api.openai.com/v1'),
    model:
      env.OPENAI_MODEL?.trim() ||
      (env.GEMINI_API_KEY?.trim()
        ? 'gemini-2.0-flash'
        : env.NVIDIA_API_KEY?.trim()
          ? 'nvidia/llama-3.1-nemotron-70b-instruct'
          : undefined),
  };
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  composioApiKey?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.apiKey && 'AI API Key (NVIDIA_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY)',
    !config.model && 'AI Model (NVIDIA_MODEL / GEMINI_MODEL / OPENAI_MODEL)',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    (config.slackUsers?.length ?? 0)
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || (config.slackUsers?.length ?? 0)
      ? 'setup_required'
      : 'not_configured';
  return {
    intelligence:
      !!config.intelligenceKey && !config.intelligenceKey.startsWith('ck_pub_'),
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack,
    missing,
  };
}
