import { claimSlot, getLastTransaction, getRecentTransactions, resolveUserId } from "../src/index";
import type { DbStressHarness } from "./db-stress-harness";

export async function runCoreStress(harness: DbStressHarness): Promise<void> {
  const { ok, userId } = harness;

  ok("resolveUserId idempotent", (await resolveUserId(harness.phone)) === userId);

  const m1 = harness.nextMessageId();
  ok("claim fresh process", (await claimSlot(m1)) === "process");
  ok("claim again recent claimed skip", (await claimSlot(m1)) === "skip");

  const m2 = harness.nextMessageId();
  const [r1, r2] = await Promise.all([claimSlot(m2), claimSlot(m2)]);
  const wins = [r1, r2].filter((result) => result === "process").length;
  ok("concurrent claim exactly one process", wins === 1, `got ${r1}/${r2}`);

  await harness.flush(m2, [
    {
      type: "expense",
      userId,
      amountCentavos: 18_000,
      category: "Transport",
      note: "grab",
      localDate: "2026-06-12",
    },
  ]);
  ok("completed marker skip", (await claimSlot(m2)) === "skip");
  const recent = await getRecentTransactions(userId, 10);
  ok(
    "expense persisted",
    recent.some(
      (transaction) =>
        transaction.amountCentavos === 18_000 && transaction.category === "Transport",
    ),
  );

  const m3 = harness.nextMessageId();
  await claimSlot(m3);
  await harness.flush(m3, [
    {
      type: "expense",
      userId,
      amountCentavos: 25_000,
      category: "Food",
      note: "jollibee",
      localDate: "2026-06-12",
    },
    {
      type: "income",
      userId,
      amountCentavos: 2_500_000,
      category: "Income",
      note: "sweldo",
      localDate: "2026-06-12",
    },
  ]);
  const last = await getLastTransaction(userId);
  ok(
    "getLastTransaction is genuinely last inserted",
    last?.amountCentavos === 2_500_000 && last?.kind === "income",
    JSON.stringify(last),
  );
}
