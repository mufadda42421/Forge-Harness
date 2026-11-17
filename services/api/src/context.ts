import type { ForgeDatabase } from "@forge/database";
import type { ModelRouter } from "@forge/core";
import type { CredentialCipher } from "@forge/security";

/** Shared services available to every route. */
export interface AppContext {
  db: ForgeDatabase;
  /** Null only when the master key cannot be initialized (credentials then unusable). */
  cipher: CredentialCipher | null;
  router: ModelRouter;
  dataDir: string;
  startedAt: number;
}
