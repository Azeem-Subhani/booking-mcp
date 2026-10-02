// Minimal types for the parts of node-postgres the test helper uses. @types/pg is deliberately not
// installed: it pulls Node's global types into the whole program, which would let `node:` imports
// in src/ typecheck.
declare module "pg" {
  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  }
  const pg: { Client: typeof Client };
  export default pg;
}
