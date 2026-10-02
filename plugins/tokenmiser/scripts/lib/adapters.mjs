// Normalizes hook payloads from different agents into one shape, and formats
// responses in each agent's dialect.
//   Copilot CLI: { sessionId, cwd, toolName, toolArgs (JSON string or object), toolResult: { resultType, textResultForLlm } }
//   Claude Code: { session_id, cwd, tool_name, tool_input, tool_response }

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return { command: v };
  }
}

function resultText(r) {
  if (r == null) return null;
  if (typeof r === 'string') return r;
  if (typeof r.textResultForLlm === 'string') return r.textResultForLlm;
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    const out = r.stdout ?? '';
    const err = r.stderr ?? '';
    return err ? `${out}${out && !out.endsWith('\n') ? '\n' : ''}${err}` : out;
  }
  if (typeof r.output === 'string') return r.output;
  if (typeof r.content === 'string') return r.content; // Claude Grep (content mode)
  if (typeof r.result === 'string') return r.result;
  return null;
}

export function normalize(payload) {
  const p = payload ?? {};
  return {
    sessionId: p.sessionId ?? p.session_id ?? 'default',
    cwd: p.cwd ?? process.cwd(),
    tool: String(p.toolName ?? p.tool_name ?? ''),
    args: parseMaybeJson(p.toolArgs ?? p.tool_input ?? {}),
    resultType: p.toolResult?.resultType ?? 'success',
    resultText: resultText(p.toolResult ?? p.tool_response),
    rawResult: p.toolResult ?? p.tool_response,
  };
}

export const respond = {
  copilot: {
    deny: (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason }),
    rewrite: (args) => ({ modifiedArgs: args }),
    // post-tool: optional replacement text and/or extra context appended for the model
    post: ({ text, context }, call) => ({
      ...(text != null && { modifiedResult: { resultType: call?.resultType ?? 'success', textResultForLlm: text } }),
      ...(context && { additionalContext: context }),
    }),
    context: (text) => ({ additionalContext: text }),
  },
  claude: {
    deny: (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
    // No permissionDecision: the normal permission flow still applies to the rewritten call.
    rewrite: (args) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: args } }),
    // updatedToolOutput must match the tool's own output shape, or Claude Code discards it.
    // Bash returns { stdout, stderr, interrupted, ... }: compressed text goes in stdout.
    post: ({ text, context }, call) => {
      const raw = call?.rawResult;
      const out = { hookEventName: 'PostToolUse' };
      if (text != null) out.updatedToolOutput = raw && typeof raw === 'object' && ('stdout' in raw || 'stderr' in raw) ? { ...raw, stdout: text, stderr: '' } : text;
      if (context) out.additionalContext = context;
      return { hookSpecificOutput: out };
    },
    context: (text) => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
  },
};
