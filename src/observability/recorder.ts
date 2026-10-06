import type { ModelCall, ModelCallRecorder } from "../ai/tracking.js";
import { modelCalls } from "../db/schema.js";
import type { Db } from "../db/types.js";

export class PgModelCallRecorder implements ModelCallRecorder {
  constructor(private readonly db: Db) {}

  async record(call: ModelCall): Promise<void> {
    await this.db.insert(modelCalls).values({ ...call, error: call.error?.slice(0, 1000) ?? null });
  }
}
