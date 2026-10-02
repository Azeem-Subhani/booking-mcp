// Vite's ?raw suffix imports a file's contents as a string.
declare module "*.sql?raw" {
  const contents: string;
  export default contents;
}

// Vite's import.meta.glob, narrowed to the eager raw-string form the test helper uses.
interface ImportMeta {
  glob<T>(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, T>;
}
