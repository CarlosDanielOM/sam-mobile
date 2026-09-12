import type { BillingMode } from './telemetry/types';

export type AuthMethod = 'oauth' | 'api_key';

export type AccountEntry = {
  id: string;
  name: string;
  blurb: string;
  methods: AuthMethod[];
  billingModes: Partial<Record<AuthMethod, BillingMode>>;
};

export const ACCOUNT_CATALOG: AccountEntry[] = [
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    blurb: 'ChatGPT Plus or Pro. No API key.',
    methods: ['oauth'],
    billingModes: { oauth: 'subscription' },
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    blurb: 'SuperGrok, X Premium, or an API key.',
    methods: ['oauth', 'api_key'],
    billingModes: { oauth: 'subscription', api_key: 'api' },
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    blurb: 'MiniMax API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
  {
    id: 'moonshotai',
    name: 'Kimi / Moonshot',
    blurb: 'Moonshot AI API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
  {
    id: 'kimi-coding',
    name: 'Kimi for Coding',
    blurb: 'Kimi Code subscription or API key.',
    methods: ['oauth', 'api_key'],
    billingModes: { oauth: 'subscription', api_key: 'api' },
  },
  {
    id: 'qwen-token-plan',
    name: 'Alibaba Qwen',
    blurb: 'Qwen Token Plan API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'token_plan' },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    blurb: 'One key for many models.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    blurb: 'Claude Pro/Max or API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
  {
    id: 'google',
    name: 'Google Gemini',
    blurb: 'Gemini API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    blurb: 'OpenAI API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    blurb: 'DeepSeek API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
  {
    id: 'groq',
    name: 'Groq',
    blurb: 'Groq API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    blurb: 'OpenCode Go API key.',
    methods: ['api_key'],
    billingModes: { api_key: 'api' },
  },
];
