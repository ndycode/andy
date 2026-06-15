import { CATEGORIES } from "@repo/shared/categories";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  date,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// MIGRATION FOOTGUN: Postgres forbids USING a freshly-added enum label in the same transaction that
// ADDs it, and the migrator (scripts/migrate.ts) wraps each migration file in one transaction. So
// adding a category requires TWO separate migration files: file A does
// `ALTER TYPE category ADD VALUE IF NOT EXISTS 'X'`; a LATER file B may reference 'X' (backfill,
// CHECK, partial index, seed). Doing both in one file aborts at apply time.
export const categoryEnum = pgEnum("category", CATEGORIES);
export const txKindEnum = pgEnum("tx_kind", ["income", "expense"]);
export const msgStatusEnum = pgEnum("msg_status", ["claimed", "completed"]);

// Money columns are bigint read back as JS numbers (mode:"number"). App validation caps amounts far
// below this, but a CHECK keeps any raw write inside the JS safe-integer range so a value can never
// silently lose precision when it round-trips through Number(). 2^53 - 1.
const MAX_SAFE_CENTAVOS = 9007199254740991;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: txKindEnum("kind").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    category: categoryEnum("category").notNull(),
    note: text("note"),
    goalId: uuid("goal_id").references(() => savingsGoals.id, { onDelete: "set null" }),
    localDate: date("local_date").notNull(),
    // Monotonic insertion order. created-instant is txn-stable (all entries of one multi-entry
    // message share it), so seq breaks the tie so "delete that" / "make that 200" always target the
    // genuinely last-inserted row.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    // Last-touched audit marker for the money ledger. Set on insert and on every edit so a corrected
    // amount/category has a record of when it changed.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tx_user_date_idx").on(t.userId, t.localDate),
    // Category-scoped month aggregation (sumByCategory, categoryAmountsThisMonth, the budgetStatuses
    // join, getSpendingByCategory) filters by (user, category) over a local_date range — the most
    // common read. A covering (user_id, category, local_date) index turns those from a user-date scan
    // + filter into an index range. The hot insert path already maintains 3 indexes; a 4th is
    // negligible at single-user volume and removes the only repeated full-category-scan reads.
    index("tx_user_cat_date_idx").on(t.userId, t.category, t.localDate),
    // Live reply loop (recent / edit-last / delete-last) sorts by recency per user.
    index("tx_user_seq_idx").on(t.userId, t.seq),
    // Goal deletion detaches by goal_id (UPDATE ... SET goal_id = NULL) and the ON DELETE SET NULL
    // referential action both look up by goal_id; index the non-null links so it's not a table scan.
    index("tx_goal_idx").on(t.goalId).where(sql`${t.goalId} IS NOT NULL`),
    // Amounts are always positive (parseAmount rejects <=0 at the app layer); enforce at the DB too.
    check("tx_amount_positive", sql`${t.amountCentavos} > 0`),
    // Keep amounts inside the JS safe-integer range (defense-in-depth; app caps far below this).
    check("tx_amount_safe", sql`${t.amountCentavos} <= ${MAX_SAFE_CENTAVOS}`),
  ],
);

export const savingsGoals = pgTable(
  "savings_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetCentavos: bigint("target_centavos", { mode: "number" }).notNull(),
    savedCentavos: bigint("saved_centavos", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    targetDate: date("target_date"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("goals_user_idx").on(t.userId),
    // One goal per (user, case-insensitive name) so "add 500 to japan" / "delete japan" resolve to a
    // single deterministic row instead of an arbitrary one of several same-named goals.
    uniqueIndex("goals_user_name_uniq").on(t.userId, sql`lower(${t.name})`),
    // Belt-and-suspenders: app logic keeps savedCentavos == sum(live contributions) via txn-scoped
    // SQL arithmetic, so this can't currently go negative — the constraint just makes the invariant
    // enforced by the DB rather than only by convention.
    check("saved_centavos_non_negative", sql`${t.savedCentavos} >= 0`),
    // A goal target is always a positive amount (parseAmount rejects <=0).
    check("goal_target_positive", sql`${t.targetCentavos} > 0`),
    // Keep amounts inside the JS safe-integer range (defense-in-depth).
    check("goal_target_safe", sql`${t.targetCentavos} <= ${MAX_SAFE_CENTAVOS}`),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: categoryEnum("category").notNull(),
    monthlyLimitCentavos: bigint("monthly_limit_centavos", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One budget per (user, category); enables upsert and prevents duplicates.
  (t) => [
    primaryKey({ columns: [t.userId, t.category] }),
    // A budget limit is always a positive amount (parseAmount rejects <=0).
    check("budget_limit_positive", sql`${t.monthlyLimitCentavos} > 0`),
    // Keep amounts inside the JS safe-integer range (defense-in-depth).
    check("budget_limit_safe", sql`${t.monthlyLimitCentavos} <= ${MAX_SAFE_CENTAVOS}`),
  ],
);

/** Dedup marker. status='completed' = true duplicate; 'claimed'-only = crashed mid-flight, safe to retry. */
export const processedMessages = pgTable("processed_messages", {
  messageId: text("message_id").primaryKey(),
  status: msgStatusEnum("status").notNull().default("claimed"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/** Weekly-summary idempotency: one row per Manila week start. */
export const summaryRuns = pgTable("summary_runs", {
  weekStartLocalDate: date("week_start_local_date").primaryKey(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memoryKindEnum = pgEnum("memory_kind", [
  "fact",
  "preference",
  "payday",
  "goal",
  "person",
  "other",
]);

export type MemoryKind = (typeof memoryKindEnum.enumValues)[number];

/** Free-form things Andy should remember about the user across conversations. */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    kind: memoryKindEnum("kind").notNull().default("fact"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Recall reads most-recent-first per user → cover (user_id, created_at desc).
  (t) => [
    index("memories_user_created_idx").on(t.userId, t.createdAt.desc()),
    // LLM-authored and fed into every prompt-context read; cap length so a runaway memory can't
    // bloat the row or the context window (mirrors the messages.content 4000-char slice).
    check("memory_content_len", sql`char_length(${t.content}) <= 4000`),
  ],
);

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);

/** Short-term conversation log — recent turns fed back so "change that to 200" works. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Monotonic insertion order. created_at defaults to now() which is txn-stable, so the user and
    // assistant turns of one inbound message share a created_at; seq breaks that tie so recentTurns
    // returns them in true insertion order (user before assistant) instead of a nondeterministic tie.
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  // recentTurns is the sole reader and orders by seq; (user_id, created_at) was pure write overhead.
  (t) => [index("messages_user_seq_idx").on(t.userId, t.seq)],
);

/** Learned merchant→category mappings, so "grab" auto-categorizes as Transport. */
export const habits = pgTable(
  "habits",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchant: text("merchant").notNull(), // lowercased note/keyword, e.g. "grab"
    category: categoryEnum("category").notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Composite PK so ON CONFLICT (user_id, merchant) works for upsert.
  (t) => [
    primaryKey({ columns: [t.userId, t.merchant] }),
    // count is a reinforcement tally, always >= 1 (the one writer inserts 1 then increments).
    check("habit_count_positive", sql`${t.count} >= 1`),
    // merchant is always a lowercased keyword (noteKeywords folds case); enforce it so a raw write
    // can't create a case-variant duplicate of the (user, merchant) key (e.g. 'Grab' vs 'grab').
    check("habit_merchant_lower", sql`${t.merchant} = lower(${t.merchant})`),
  ],
);

export const cadenceEnum = pgEnum("cadence", ["weekly", "monthly"]);

/** Recurring bills/income Andy reminds about (no auto-charge). */
export const recurringItems = pgTable(
  "recurring_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    kind: txKindEnum("kind").notNull().default("expense"),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    category: categoryEnum("category").notNull(),
    cadence: cadenceEnum("cadence").notNull(),
    dayOfMonth: bigint("day_of_month", { mode: "number" }), // 1-31 for monthly
    dayOfWeek: bigint("day_of_week", { mode: "number" }), // 0=Sun..6=Sat for weekly
    lastRemindedDate: date("last_reminded_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recurring_user_idx").on(t.userId),
    // One recurring item per (user, case-insensitive label) so a duplicate bill can't accrue and
    // fire a duplicate reminder every cadence period; addRecurring upserts on this key.
    uniqueIndex("recurring_user_label_uniq").on(t.userId, sql`lower(${t.label})`),
    // Amount is always positive (parseAmount rejects <=0).
    check("recurring_amount_positive", sql`${t.amountCentavos} > 0`),
    // Keep amounts inside the JS safe-integer range (defense-in-depth).
    check("recurring_amount_safe", sql`${t.amountCentavos} <= ${MAX_SAFE_CENTAVOS}`),
    // Day-of-month is 1..31, day-of-week is 0..6 (Sun..Sat) when present.
    check("day_of_month_range", sql`${t.dayOfMonth} IS NULL OR ${t.dayOfMonth} BETWEEN 1 AND 31`),
    check("day_of_week_range", sql`${t.dayOfWeek} IS NULL OR ${t.dayOfWeek} BETWEEN 0 AND 6`),
    // The cadence MUST carry the matching day, or the item silently never fires in
    // dueRecurringToday (monthly needs day_of_month; weekly needs day_of_week). Enforced at the DB
    // so no write path — app or manual — can create a permanently-dead reminder.
    check(
      "cadence_day_consistency",
      sql`(${t.cadence} = 'monthly' AND ${t.dayOfMonth} IS NOT NULL) OR (${t.cadence} = 'weekly' AND ${t.dayOfWeek} IS NOT NULL)`,
    ),
  ],
);

/** Dedup log so proactive nudges don't spam (one per kind+key per Manila week). */
export const nudges = pgTable(
  "nudges",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // e.g. "budget:Food"
    weekStartLocalDate: date("week_start_local_date").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // UNIQUE (not just an index) so recordNudge can claim a slot atomically via
  // onConflictDoNothing().returning() — record-before-send: only the claim winner texts, so a
  // record failure can't lead to a duplicate nudge on the next cron tick.
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.weekStartLocalDate] })],
);
