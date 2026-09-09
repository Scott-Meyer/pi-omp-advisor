<project-context>
Context files: user's standing project instructions (AGENTS.md etc.) for the driving agent. Respect explicit constraints in the context of the full conversation; distinguish mandates from examples, shorthand, and evolving discussion. Your role remains an observer, not the agent carrying out these instructions.
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-context>
