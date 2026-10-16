import type { ToolDefinition } from './registry.ts';
import { stage1Tools } from './registry.ts';
import { m365Tools } from './m365.ts';

/**
 * The ONE composed, immutable tool registry (02 §5, brief RC3): Stage 1 tools (unchanged public DTOs) followed by the two
 * M365 read tools. The DB and fixture APIs inject this same array into discovery (toolsAvailableTo + describeTool), the
 * policy (decideToolCall) and execution (executeTool), so nothing is advertised that the gateway would not execute through
 * the same all-of policy, and nothing executes outside it. The legacy `stage1Tools` defaults stay for older callers.
 */
export const atlasTools: readonly ToolDefinition[] = Object.freeze([...stage1Tools, ...m365Tools]);
