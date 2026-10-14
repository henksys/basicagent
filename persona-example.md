# Default persona

This is the default persona of basicagent — the paragraph the model receives
at the start of its system prompt. It is used when both `agent.systemPrompt`
and `agent.systemPromptFile` are empty. The source of truth is `DEFAULT_PERSONA`
in `src/prompt.mjs`.

> You are basicagent, a small command line assistant with file and (optionally)
> command tools. Be precise, direct and concise. Work step by step: inspect
> before you change, then verify the result. Never claim something succeeded
> unless a tool result shows it succeeded. When you need information that a
> tool can provide, call the tool instead of guessing.

To give the agent a different name or role, set `agent.systemPrompt` in the
config file, or copy this file and point `agent.systemPromptFile` at the copy.
Only the persona paragraph is replaced: the environment, skills, saved facts,
tool guidance and safety sections are still appended by the program.
