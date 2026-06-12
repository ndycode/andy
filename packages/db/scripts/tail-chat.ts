import postgres from "postgres";

// Live transcript tailer: prints new conversation turns (user + Andy) as they land in the DB.
// Dedups by row id (NOT timestamp) — Postgres stores microseconds but a JS Date only has ms, so a
// `created_at > lastSeen` filter re-matches the same row forever. Tracking ids avoids that.
const sql = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 1 });

const printed = new Set<string>();
let bootstrapped = false;

function fmt(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour12: false, timeZone: "Asia/Manila" });
}

process.stdout.write("watching conversation (Manila time)\n");

for (;;) {
  try {
    const rows = await sql<{ id: string; role: string; content: string; created_at: Date }[]>`
      select id, role, content, created_at
      from messages
      order by created_at desc
      limit 30`;
    // Oldest-first for readable output.
    const ordered = rows.slice().reverse();
    for (const r of ordered) {
      if (printed.has(r.id)) continue;
      printed.add(r.id);
      // On first pass, mark existing history as seen without printing (avoid dumping old chat).
      if (!bootstrapped) continue;
      const who = r.role === "user" ? "YOU " : "ANDY";
      process.stdout.write(`[${fmt(r.created_at)}] ${who}: ${r.content.replace(/\n/g, " / ")}\n`);
    }
    bootstrapped = true;
    // Keep the id set from growing unbounded over a long session.
    if (printed.size > 500) {
      const keep = new Set(rows.map((r) => r.id));
      for (const id of printed) if (!keep.has(id)) printed.delete(id);
    }
  } catch (e) {
    process.stdout.write(`tail error: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  await new Promise((r) => setTimeout(r, 4000));
}
