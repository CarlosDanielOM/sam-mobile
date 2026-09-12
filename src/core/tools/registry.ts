import { assertTimeout, assertToolName, capabilityId, snapshotJson } from './contracts';
import type { ExecutableTool, ModelToolDefinition, ToolContext, ToolDefinition, ToolVisibility } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, ExecutableTool>();

  register(tool: ExecutableTool): void {
    const definition = tool.definition;
    assertToolName(definition.name);
    if (this.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    assertTimeout(definition.defaultTimeoutMs);
    definition.capabilities.forEach(capabilityId);
    if (!definition.description.trim()) throw new Error('Tool description is required');
    if (!definition.inputSchema || Array.isArray(definition.inputSchema) || typeof definition.inputSchema !== 'object') {
      throw new Error('Tool inputSchema must be a JSON Schema object');
    }
    if (typeof tool.validateInput !== 'function' || typeof tool.execute !== 'function') {
      throw new Error('Tools require an input validator and executor');
    }
    if (definition.outputSchema !== undefined) {
      if (!definition.outputSchema || Array.isArray(definition.outputSchema) || typeof definition.outputSchema !== 'object') {
        throw new Error('Tool outputSchema must be a JSON Schema object');
      }
      if (typeof tool.validateOutput !== 'function') {
        throw new Error('Tools advertising an outputSchema require an output validator');
      }
    }
    // Copy only declared fields. Never serialize executable implementations or private extras.
    const registered = snapshotJson({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      capabilities: definition.capabilities,
      ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
      ...(definition.metadata === undefined ? {} : { metadata: definition.metadata }),
      ...(definition.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: definition.defaultTimeoutMs }),
    }) as ToolDefinition;
    this.tools.set(definition.name, Object.freeze({
      definition: registered,
      validateInput: tool.validateInput,
      validateOutput: tool.validateOutput,
      execute: tool.execute,
    }));
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Internal executable lookup. Model callers should use modelDefinitions instead. */
  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name);
  }

  list(context: ToolContext = {}, visible?: ToolVisibility): readonly ToolDefinition[] {
    return Array.from(this.tools.values(), (tool) => tool.definition)
      .filter((definition) => !visible || visible(definition, context));
  }

  modelDefinitions(context: ToolContext = {}, visible?: ToolVisibility): readonly ModelToolDefinition[] {
    return this.list(context, visible).map((definition) => Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    }));
  }
}
