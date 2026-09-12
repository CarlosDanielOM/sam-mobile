export const SAM_AGENT_ID = 'agent:sam';

export const DEFAULT_SYSTEM_PROMPT =
  "You are SAM, a concise personal assistant on the user's phone.";

export type AgentDefinition = {
  id: string;
  name: string;
  defaultPrompt: string;
};

export const AGENT_CATALOG: AgentDefinition[] = [
  { id: SAM_AGENT_ID, name: 'SAM', defaultPrompt: DEFAULT_SYSTEM_PROMPT },
];

export function effectivePrompt(stored: string | undefined, fallback: string): string {
  const text = stored?.trim();
  return text ? text : fallback;
}

export function agentById(id: string): AgentDefinition | undefined {
  return AGENT_CATALOG.find((agent) => agent.id === id);
}
