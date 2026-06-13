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
  uuid,
} from "drizzle-orm/pg-core";

export const categoryEnum = pgEnum("category", CATEGORIES);
export const txKindEnum = pgEnum("tx_kind", ["income", "expense"]);
export const msgStatusEnum = pgEnum("msg_status", ["claimed", "completed"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull().unique(),
  timezone: text("timezone").notNull().default("Asia/Manila"),
  currency: text("currency").notNull().default("PHP"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: txKindEnum("kind").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    category: categoryEnum("category").notNull(),
    note: text("note"),
    goalId: uuid("goal_id").references(() => savingsGoals.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    localDate: date("local_date").notNull(),
    // Monotonic insertion order. occurredAt defaults to now() which is txn-stable, so all
    // entries of one multi-entry message share an occurredAt; seq breaks the tie so
    // "delete that" / "make that 200" always target the genuinely last-inserted row.
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (t) => [
    index("tx_user_date_idx").on(t.userId, t.localDate),
    // Live reply loop (recent / edit-last / delete-last) sorts by recency per user.
    index("tx_user_seq_idx").on(t.userId, t.seq),
    // Amounts are always positive (parseAmount rejects <=0 at the app layer); enforce at the DB too.
    check("tx_amount_positive", sql`${t.amountCentavos} > 0`),
  ],
);

export const savingsGoals = pgTable(
  "savings_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    targetCentavos: bigint("target_centavos", { mode: "number" }).notNull(),
    savedCentavos: bigint("saved_centavos", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    targetDate: date("target_date"),
  },
  (t) => [
    index("goals_user_idx").on(t.userId),
    // Belt-and-suspenders: app logic keeps savedCentavos == sum(live contributions) via txn-scoped
    // SQL arithmetic, so this can't currently go negative — the constraint just makes the invariant
    // enforced by the DB rather than only by convention.
    check("saved_centavos_non_negative", sql`${t.savedCentavos} >= 0`),
    // A goal target is always a positive amount (parseAmount rejects <=0).
    check("goal_target_positive", sql`${t.targetCentavos} > 0`),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    category: categoryEnum("category").notNull(),
    monthlyLimitCentavos: bigint("monthly_limit_centavos", { mode: "number" }).notNull(),
  },
  // One budget per (user, category); enables upsert and prevents duplicates.
  (t) => [
    primaryKey({ columns: [t.userId, t.category] }),
    // A budget limit is always a positive amount (parseAmount rejects <=0).
    check("budget_limit_positive", sql`${t.monthlyLimitCentavos} > 0`),
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
      .references(() => users.id),
    content: text("content").notNull(),
    kind: memoryKindEnum("kind").notNull().default("fact"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Recall reads most-recent-first per user → cover (user_id, created_at desc).
  (t) => [index("memories_user_created_idx").on(t.userId, t.createdAt.desc())],
);

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);

/** Short-term conversation log — recent turns fed back so "change that to 200" works. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_user_time_idx").on(t.userId, t.createdAt)],
);

/** Learned merchant→category mappings, so "grab" auto-categorizes as Transport. */
export const habits = pgTable(
  "habits",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    merchant: text("merchant").notNull(), // lowercased note/keyword, e.g. "grab"
    category: categoryEnum("category").notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Composite PK so ON CONFLICT (user_id, merchant) works for upsert.
  (t) => [primaryKey({ columns: [t.userId, t.merchant] })],
);

export const cadenceEnum = pgEnum("cadence", ["weekly", "monthly"]);

/** Recurring bills/income Andy reminds about (no auto-charge). */
export const recurringItems = pgTable(
  "recurring_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    label: text("label").notNull(),
    kind: txKindEnum("kind").notNull().default("expense"),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    category: categoryEnum("category").notNull(),
    cadence: cadenceEnum("cadence").notNull(),
    dayOfMonth: bigint("day_of_month", { mode: "number" }), // 1-31 for monthly
    dayOfWeek: bigint("day_of_week", { mode: "number" }), // 0=Sun..6=Sat for weekly
    lastRemindedDate: date("last_reminded_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recurring_user_idx").on(t.userId),
    // Amount is always positive (parseAmount rejects <=0).
    check("recurring_amount_positive", sql`${t.amountCentavos} > 0`),
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
      .references(() => users.id),
    kind: text("kind").notNull(), // e.g. "budget:Food"
    weekStartLocalDate: date("week_start_local_date").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // UNIQUE (not just an index) so recordNudge can claim a slot atomically via
  // onConflictDoNothing().returning() — record-before-send: only the claim winner texts, so a
  // record failure can't lead to a duplicate nudge on the next cron tick.
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.weekStartLocalDate] })],
);
