import { openaiCodexOAuth } from '../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js';
import { kimiCodingOAuth } from '../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/kimi-coding.js';
import { xaiOAuth } from '../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/xai.js';
import { registerBundledOAuthFlowLoaders } from '../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/load.js';

function unavailable(name: string) {
  return () => {
    throw new Error(`${name} is not bundled in SAM`);
  };
}

registerBundledOAuthFlowLoaders({
  anthropic: unavailable('Anthropic OAuth'),
  openaiCodex: () => openaiCodexOAuth,
  githubCopilot: unavailable('GitHub Copilot OAuth'),
  openrouter: unavailable('OpenRouter OAuth'),
  kimiCoding: () => kimiCodingOAuth,
  xai: () => xaiOAuth,
  radius: unavailable('Radius OAuth'),
});
