import { TURNING_ZERO_CORE_BACKFILL_ITEMS } from "./turning-zero-core-backfill-fixtures.js";

const BASE_URL = process.env.MEMU_BASE_URL ?? "http://127.0.0.1:8000";
const USER_ID = process.env.MEMU_USER_ID ?? "example_user";
const AGENT_ID = process.env.MEMU_AGENT_ID ?? "turning_zero";
const CHUNK_SIZE = 10;

async function main() {
  console.log(`Upserting ${TURNING_ZERO_CORE_BACKFILL_ITEMS.length} core memory items for ${USER_ID}/${AGENT_ID} via ${BASE_URL}...`);

  let upserted = 0;
  for (let i = 0; i < TURNING_ZERO_CORE_BACKFILL_ITEMS.length; i += CHUNK_SIZE) {
    const chunk = TURNING_ZERO_CORE_BACKFILL_ITEMS.slice(i, i + CHUNK_SIZE);
    const payload = {
      user_id: USER_ID,
      agent_id: AGENT_ID,
      items: chunk.map((item) => ({
        category: item.category,
        key: item.key,
        value: item.value,
        importance: item.importance,
        provenance: { source: item.provenance },
      })),
    };

    const res = await fetch(`${BASE_URL}/core/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`core/upsert failed (${res.status}): ${text}`);
    }

    const body = await res.json() as { status?: string; result?: { upserted?: number } };
    if (body.status !== "success") {
      throw new Error(`core/upsert returned non-success: ${JSON.stringify(body)}`);
    }
    upserted += body.result?.upserted ?? chunk.length;
    console.log(`  chunk ${Math.floor(i / CHUNK_SIZE) + 1}: upserted ${body.result?.upserted ?? chunk.length}`);
  }

  console.log(`Done. Upserted ${upserted} item(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
