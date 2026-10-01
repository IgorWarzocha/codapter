import { Type } from "@sinclair/typebox";

export const SPAWN_AGENT_DESCRIPTION = `Only use spawn_agent if and only if the user explicitly asks for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn.

Spawn a sub-agent for a well-scoped task. Returns metadata for exactly one spawned agent: the canonical agent_id and, when available, a user-facing nickname for that same agent. Do not treat agent_id and nickname as separate agents.

{available_models_description}

Use either \`message\` or \`items\`. If you already have structured text/image inputs, pass them via \`items\`; otherwise use \`message\`. If both are present, they should describe the same task.

### Parameter guidance
- Omit \`agent_type\` unless you need a specific role. \`default\` is the normal general-purpose choice.
- Use \`worker\` for concrete execution or code-edit subtasks with a bounded write scope.
- Omit \`reasoning_effort\` unless you need to change it. When you do set it, prefer matching the parent unless the task is clearly simpler or harder.

### When to delegate vs. do the subtask yourself
- First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks are sidecar tasks that can run in parallel without blocking the next local step.
- Use the smaller subagent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task.
- Do not delegate urgent blocking work when your immediate next step depends on that result.
- Keep work local when the subtask is tightly coupled, urgent, or likely to block your immediate next step.

### Designing delegated subtasks
- Subtasks must be concrete, well-defined, and self-contained.
- Do not duplicate work between the main rollout and delegated subtasks.
- Narrow the delegated ask to the concrete output you need next.
- For coding tasks, prefer delegating concrete code-change worker subtasks; otherwise leave \`agent_type\` unset.
- For code-edit subtasks, decompose work so each delegated task has a disjoint write set.

### After you delegate
- Call wait_agent very sparingly. Only call wait_agent when you need the result immediately for the next critical-path step.
- Do not redo delegated subagent tasks yourself; focus on integrating results or tackling non-overlapping work.
- While the subagent is running, do meaningful non-overlapping work immediately.
- Do not repeatedly wait by reflex.
- After a subagent finishes successfully, prefer leaving it available for likely follow-up work instead of closing it immediately.
- Only close a subagent when the user explicitly asks to close it, or when you are confident the work is fully done and the agent is unlikely to be reused.

### Parallel delegation patterns
- Run multiple independent subtasks in parallel when you have distinct questions.
- Split implementation into disjoint codebase slices and spawn multiple agents.
- The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round.`;

const InputItem = Type.Object(
  {
    type: Type.String(),
  },
  { additionalProperties: true }
);

export const SpawnAgentParams = Type.Object({
  message: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(InputItem)),
  agent_type: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  reasoning_effort: Type.Optional(Type.String()),
  fork_context: Type.Optional(Type.Boolean()),
});

export const SendInputParams = Type.Object({
  id: Type.String(),
  message: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(InputItem)),
  interrupt: Type.Optional(Type.Boolean()),
});

export const WaitAgentParams = Type.Object({
  ids: Type.Array(Type.String()),
  timeout_ms: Type.Optional(Type.Number()),
});

export const CloseAgentParams = Type.Object({
  id: Type.String(),
});

export const ResumeAgentParams = Type.Object({
  id: Type.String(),
});
