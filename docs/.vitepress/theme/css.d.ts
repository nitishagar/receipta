// Ambient declaration: .css imports are resolved by Vite/VitePress at build time,
// but tsc (pnpm typecheck) needs to accept them too. This keeps theme/index.ts
// fully type-checked (INV-8) without a build step.
declare module '*.css';
