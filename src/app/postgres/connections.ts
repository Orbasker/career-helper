import { eq, sql } from "drizzle-orm";
import { readConnectionsFile } from "../../connections/parse.js";
import { connections } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { normalizeCompany } from "../../ingestion/normalize.js";
import type { ConnectionImport, ConnectionService, ConnectionSummary } from "../services.js";

const INSERT_BATCH_SIZE = 500;

export class PgConnectionService implements ConnectionService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async import(userId: string, file: { data: Uint8Array; fileName: string | null }): Promise<ConnectionImport> {
    const parsed = await readConnectionsFile(file.data, file.fileName);
    if (!parsed) return { kind: "not_connections" };
    if (parsed.connections.length === 0) return { kind: "empty" };

    const importedAt = this.now();
    const rows = parsed.connections.map((c) => ({ ...c, userId, normalizedCompany: normalizeCompany(c.company), importedAt }));
    await this.db.transaction(async (tx) => {
      await tx.delete(connections).where(eq(connections.userId, userId));
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        await tx.insert(connections).values(rows.slice(i, i + INSERT_BATCH_SIZE));
      }
    });
    const companies = new Set(rows.map((r) => r.normalizedCompany).filter(Boolean)).size;
    return { kind: "imported", contacts: rows.length, companies, skipped: parsed.skipped };
  }

  async summary(userId: string): Promise<ConnectionSummary | null> {
    const [row] = await this.db
      .select({
        contacts: sql<number>`count(*)`.mapWith(Number),
        companies: sql<number>`count(distinct ${connections.normalizedCompany})`.mapWith(Number),
        importedAt: sql<Date | null>`max(${connections.importedAt})`.mapWith((v) => (v ? new Date(v) : null)),
      })
      .from(connections)
      .where(eq(connections.userId, userId));
    return row && row.contacts > 0 && row.importedAt ? { contacts: row.contacts, companies: row.companies, importedAt: row.importedAt } : null;
  }

  async forget(userId: string): Promise<number> {
    const deleted = await this.db.delete(connections).where(eq(connections.userId, userId)).returning({ id: connections.id });
    return deleted.length;
  }
}
