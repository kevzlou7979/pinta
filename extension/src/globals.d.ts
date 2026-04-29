// Ambient declarations for Vite-specific import suffixes that TypeScript
// doesn't know about by default. Vite resolves these at build time.

declare module "*.css?inline" {
  const content: string;
  export default content;
}
