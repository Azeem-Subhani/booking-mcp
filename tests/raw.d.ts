// Vite's ?raw suffix imports a file's contents as a string.
declare module "*.sql?raw" {
  const contents: string;
  export default contents;
}
