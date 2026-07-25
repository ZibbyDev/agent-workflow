// Ambient declarations for OPTIONAL peers that agent-workflow does not depend on
// at build time. `graph.ts` does an optional `import('@zibby/skills')` for skill
// resolution when the host app provides it; agent-workflow itself never lists it
// as a dependency, so TS would otherwise error "Cannot find module". This keeps
// that dynamic import untyped (any) without a build error.
declare module '@zibby/skills';
