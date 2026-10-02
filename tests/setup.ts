import { afterEach } from "vitest";

import { cleanupDatabases } from "./helpers.ts";

afterEach(cleanupDatabases);
