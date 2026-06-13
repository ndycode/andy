import {
  budgetStatuses,
  findGoalByName,
  findRecurringByLabel,
  getInsights,
  getMonthOverview,
  getRecentTransactions,
  getSpendingByCategory,
  listGoals,
  listRecurring,
  searchTransactions,
  sumByCategory,
} from "@repo/db";
import { spendingDelta, spendingPace } from "@repo/shared/analytics";
import { type CATEGORIES, type Category, coerceCategory } from "@repo/shared/categories";
import { goalProgressMessage } from "@repo/shared/goals";
import { formatPHP, parseAmount } from "@repo/shared/money";
import {
  daysInLocalMonth,
  localDayOfMonth,
  monthAnchor,
  monthRange,
  prevMonthAnchor,
  validateCalendarDate,
  validateLogDate,
} from "@repo/shared/time";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

/**
 * Build the finance tool map bound to a request context.
 * Write-tools buffer intents via ctx.addWrite (no DB connection held during the agent run).
 * Read-tools issue their own short reads.
 */
export function buildTools(ctx: ToolContext) {
  const amount = z
    .string()
    .describe('Amount token exactly as written, e.g. "180", "25k". No conversion.');
  // Category as a plain string (valid list lives once in the system prompt, not repeated per-tool —
  // saves re-sending the 9-value enum across ~8 tools every step). coerceCategory() hardens it
  // server-side on every write path, so a bad value safely becomes "Other".
  const category = z.string().describe("One of the listed categories.");
  // Optional backdate: the LLM resolves natural language ("yesterday", "last friday") against the
  // <today> block into YYYY-MM-DD; validateLogDate() hardens it server-side (real date, not future,
  // not absurdly old). Omitted → today.
  const date = z
    .string()
    .optional()
    .describe("Date the expense/income happened, YYYY-MM-DD. Omit for today.");
  // Optional historical month for read tools, resolved by the LLM to YYYY-MM. Omitted → this month.
  const month = z
    .string()
    .optional()
    .describe("Month to query as YYYY-MM (e.g. '2026-05'). Omit for the current month.");

  // Resolve an optional backdate against validateLogDate; returns the localDate string or an error.
  const resolveLogDate = (
    d: string | undefined,
  ): { ok: true; date: string } | { ok: false; error: string } => {
    if (d === undefined) return { ok: true, date: ctx.today };
    const r = validateLogDate(d, new Date(`${ctx.today}T12:00:00Z`));
    return r.ok ? { ok: true, date: r.date } : { ok: false, error: r.reason };
  };

  // ── logging ──────────────────────────────────────────────
  const logExpense = tool({
    description: "Log one spending/expense entry. Once per distinct expense.",
    inputSchema: z.object({
      amount,
      category,
      note: z.string().optional().describe("Short label, e.g. 'lunch', 'grab'."),
      date,
    }),
    execute: ({ amount, category, note, date }) => {
      const r = parseAmount(amount);
      if (!r.ok) return { ok: false, error: r.reason };
      const d = resolveLogDate(date);
      if (!d.ok) return { ok: false, error: d.error };
      ctx.addWrite({
        type: "expense",
        userId: ctx.userId,
        amountCentavos: r.centavos,
        category: coerceCategory(category),
        note,
        localDate: d.date,
      });
      return { ok: true, logged: formatPHP(r.centavos), category, date: d.date };
    },
  });

  const logIncome = tool({
    description: "Log an income entry (sweldo, salary, payment received).",
    inputSchema: z.object({ amount, note: z.string().optional(), date }),
    execute: ({ amount, note, date }) => {
      const r = parseAmount(amount);
      if (!r.ok) return { ok: false, error: r.reason };
      const d = resolveLogDate(date);
      if (!d.ok) return { ok: false, error: d.error };
      ctx.addWrite({
        type: "income",
        userId: ctx.userId,
        amountCentavos: r.centavos,
        category: "Income",
        note,
        localDate: d.date,
      });
      return { ok: true, logged: formatPHP(r.centavos), date: d.date };
    },
  });

  // ── questions / reads ────────────────────────────────────
  // Resolve an optional YYYY-MM into the `at` Date the month-scoped queries expect; null month → now.
  const resolveMonthAt = (
    m: string | undefined,
  ): { at: Date | undefined; label: string | null } => {
    if (m === undefined) return { at: undefined, label: null };
    const anchor = monthAnchor(m);
    return anchor ? { at: anchor, label: m } : { at: undefined, label: null };
  };

  const getSpending = tool({
    description: "Total spending in ONE category, this month or a past month.",
    inputSchema: z.object({ category, month }),
    execute: async ({ category, month }) => {
      const cat = coerceCategory(category);
      const { at, label } = resolveMonthAt(month);
      const total = await sumByCategory(ctx.userId, cat, at ?? new Date());
      return { category: cat, total: formatPHP(total), month: label };
    },
  });

  const getOverview = tool({
    description:
      "Income, expenses, and net for this month or a past month. For 'how am i doing', 'am i broke', 'how was may'.",
    inputSchema: z.object({ month }),
    execute: async ({ month }) => {
      const { at, label } = resolveMonthAt(month);
      const o = await getMonthOverview(ctx.userId, at ?? new Date());
      return {
        income: formatPHP(o.income),
        expenses: formatPHP(o.expense),
        net: formatPHP(o.net),
        month: label,
      };
    },
  });

  const getCategoryBreakdown = tool({
    description:
      "Spending by category (biggest first), this month or a past month. For 'where's my money going'.",
    inputSchema: z.object({ month }),
    execute: async ({ month }) => {
      const { at, label } = resolveMonthAt(month);
      const rows = await getSpendingByCategory(ctx.userId, at ?? new Date());
      return {
        breakdown: rows.map((r) => ({ category: r.category, total: formatPHP(r.total) })),
        month: label,
      };
    },
  });

  const getRecent = tool({
    description: "List recent transactions. For 'what did i spend recently/yesterday'.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(25).optional() }),
    execute: async ({ limit }) => {
      const rows = await getRecentTransactions(ctx.userId, limit ?? 10);
      return {
        transactions: rows.map((r) => ({
          kind: r.kind,
          amount: formatPHP(r.amountCentavos),
          category: r.category,
          note: r.note,
          date: r.localDate,
        })),
      };
    },
  });

  // ── savings goals ────────────────────────────────────────
  const createGoal = tool({
    description: "Create a savings goal, e.g. 'save 20k for a laptop by December'.",
    inputSchema: z.object({
      name: z.string().describe("Short goal name, e.g. 'Laptop'."),
      target: amount,
      targetDate: z.string().optional().describe("Deadline YYYY-MM-DD, omit if none."),
    }),
    execute: ({ name, target, targetDate }) => {
      const r = parseAmount(target);
      if (!r.ok) return { ok: false, error: r.reason };
      // Harden the deadline: the LLM must resolve "december" → YYYY-MM-DD; reject anything else so a
      // raw/invalid date can't reach the DB and later render as "Invalid Date"/NaN pace in status.
      let deadline: string | null = null;
      if (targetDate !== undefined && targetDate.trim() !== "") {
        const dv = validateCalendarDate(targetDate);
        if (!dv.ok) return { ok: false, error: `deadline ${dv.reason}` };
        deadline = dv.date;
      }
      ctx.addWrite({
        type: "createGoal",
        userId: ctx.userId,
        name,
        targetCentavos: r.centavos,
        targetDate: deadline,
      });
      return { ok: true, name, target: formatPHP(r.centavos), targetDate: deadline };
    },
  });

  const contributeToGoal = tool({
    description:
      "Add money to an existing goal, e.g. 'put 2000 to emergency fund'. Accepts an optional backdate like logExpense.",
    inputSchema: z.object({ goalName: z.string(), amount, date }),
    execute: async ({ goalName, amount, date }) => {
      const r = parseAmount(amount);
      if (!r.ok) return { ok: false, error: r.reason };
      const d = resolveLogDate(date);
      if (!d.ok) return { ok: false, error: d.error };
      const goal = await findGoalByName(ctx.userId, goalName);
      if (!goal) return { ok: false, error: `no goal matching "${goalName}". create it first.` };
      ctx.addWrite({
        type: "goalContribution",
        userId: ctx.userId,
        goalId: goal.id,
        amountCentavos: r.centavos,
        localDate: d.date,
      });
      const newSaved = goal.savedCentavos + r.centavos;
      return {
        ok: true,
        goal: goal.name,
        added: formatPHP(r.centavos),
        date: d.date,
        progress: `${formatPHP(newSaved)} / ${formatPHP(goal.targetCentavos)}`,
      };
    },
  });

  const getGoalStatus = tool({
    description: "Goal progress and pace. For 'how's my laptop fund'.",
    inputSchema: z.object({ goalName: z.string().optional() }),
    execute: async ({ goalName }) => {
      const goals = await listGoals(ctx.userId);
      if (goals.length === 0) return { goals: [], note: "no savings goals yet." };
      // Use the request's Manila "today" (not server-UTC) so pace math is consistent with how
      // dates were resolved when goals/deadlines were created.
      const today = new Date(`${ctx.today}T00:00:00Z`);
      const chosen = goalName
        ? [await findGoalByName(ctx.userId, goalName)].filter(Boolean)
        : goals;
      const list = (chosen.length ? chosen : goals) as typeof goals;
      return {
        goals: list.map((g) =>
          goalProgressMessage({
            name: g.name,
            savedCentavos: g.savedCentavos,
            targetCentavos: g.targetCentavos,
            createdAt: g.createdAt,
            today,
            targetDate: g.targetDate ? new Date(g.targetDate) : null,
          }),
        ),
      };
    },
  });

  const editGoal = tool({
    description:
      "Edit an existing savings goal's name, target amount, or deadline. For 'rename my trip fund to japan', 'make the laptop goal 30k', 'move the emergency deadline to march'. Populate at least one field.",
    inputSchema: z.object({
      goalName: z.string().describe("name (or part) of the goal to edit"),
      newName: z.string().optional().describe("new goal name"),
      target: amount.optional().describe("new target amount, token as written"),
      targetDate: z.string().optional().describe("new deadline YYYY-MM-DD, or 'none' to clear it"),
    }),
    execute: async ({ goalName, newName, target, targetDate }) => {
      const goal = await findGoalByName(ctx.userId, goalName);
      if (!goal) return { ok: false, error: `no goal matching "${goalName}".` };
      const patch: { name?: string; targetCentavos?: number; targetDate?: string | null } = {};
      if (newName) patch.name = newName;
      if (target !== undefined) {
        const r = parseAmount(target);
        if (!r.ok) return { ok: false, error: r.reason };
        patch.targetCentavos = r.centavos;
      }
      if (targetDate !== undefined) {
        // "none"/"clear"/"" wipes the deadline; otherwise validate it as a real calendar date (any
        // direction — a goal deadline can be in the future, unlike a backdated log).
        const t = targetDate.trim().toLowerCase();
        if (t === "none" || t === "clear" || t === "") patch.targetDate = null;
        else {
          const dv = validateCalendarDate(targetDate);
          if (!dv.ok)
            return { ok: false, error: `deadline ${dv.reason} (use YYYY-MM-DD or 'none')` };
          patch.targetDate = dv.date;
        }
      }
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: "no change specified — pass a new name, target, or deadline" };
      }
      ctx.addWrite({ type: "editGoal", userId: ctx.userId, goalId: goal.id, patch });
      return {
        ok: true,
        goal: patch.name ?? goal.name,
        target: formatPHP(patch.targetCentavos ?? goal.targetCentavos),
        targetDate: patch.targetDate !== undefined ? patch.targetDate : goal.targetDate,
      };
    },
  });

  const deleteGoal = tool({
    description:
      "Delete a savings goal entirely. For 'delete my trip goal', 'cancel the laptop fund', 'remove that goal'. Contributions stay logged as Savings/Goals expenses; only the goal is removed.",
    inputSchema: z.object({ goalName: z.string() }),
    execute: async ({ goalName }) => {
      const goal = await findGoalByName(ctx.userId, goalName);
      if (!goal) return { ok: false, error: `no goal matching "${goalName}".` };
      ctx.addWrite({ type: "deleteGoal", userId: ctx.userId, goalId: goal.id });
      return { ok: true, deleted: goal.name };
    },
  });

  // ── memory ───────────────────────────────────────────────
  const remember = tool({
    description: "Save a durable fact (preferences, paydays, plans). For 'remember that...'.",
    inputSchema: z.object({
      fact: z.string(),
      kind: z
        .enum(["fact", "preference", "payday", "goal", "person", "other"])
        .optional()
        .describe("Type of memory; defaults to fact."),
    }),
    execute: ({ fact, kind }) => {
      ctx.addWrite({ type: "saveMemory", userId: ctx.userId, content: fact, kind: kind ?? "fact" });
      return { ok: true, remembered: fact };
    },
  });

  const forgetMemory = tool({
    description: "Delete a saved memory. For 'forget that...', 'don't remember...'.",
    inputSchema: z.object({
      match: z.string().describe("Words identifying the memory to forget."),
    }),
    execute: ({ match }) => {
      ctx.addWrite({ type: "forgetMemory", userId: ctx.userId, match });
      return { ok: true, forgetting: match };
    },
  });

  const listMemory = tool({
    description: "List what you remember about the user. For 'what do you know about me'.",
    inputSchema: z.object({}),
    execute: () => {
      return { remembered: ctx.memories };
    },
  });

  // ── edit / delete ────────────────────────────────────────
  // Target resolution: if a transaction was logged earlier THIS turn ("grab 180, no make it 200"),
  // target that just-logged entry; otherwise pin the loop-start snapshot id (stable across a
  // 429 retry). Either way no historical row is silently clobbered.
  //
  // This FORWARD replay must mirror flushWrites' `lastInsertedTxId` exactly — same set of intents
  // count as an insert (expense/income/goalContribution), and a same-turn delete clears it — so the
  // row the reply describes is always the row flushWrites will actually edit/delete.
  const lastBufferedTx = (): {
    amountCentavos: number;
    category: Category;
    note: string | null;
  } | null => {
    let last: { amountCentavos: number; category: Category; note: string | null } | null = null;
    for (const w of ctx.peekWrites()) {
      if (w.type === "expense" || w.type === "income") {
        last = { amountCentavos: w.amountCentavos, category: w.category, note: w.note ?? null };
      } else if (w.type === "goalContribution") {
        last = { amountCentavos: w.amountCentavos, category: "Savings/Goals", note: null };
      } else if (w.type === "editLast" && w.targetSameTurn && last) {
        // A same-turn edit of the just-logged row: apply the patch so a following "delete that"
        // confirmation echoes the post-edit values, not the original ones. flushWrites applies the
        // same patch to the row, so the reply matches what's actually stored/removed.
        if (w.patch.amountCentavos != null) last.amountCentavos = w.patch.amountCentavos;
        if (w.patch.category != null) last.category = w.patch.category;
        if (w.patch.note != null) last.note = w.patch.note;
      } else if (w.type === "deleteLast" && w.targetSameTurn) {
        last = null; // the just-logged row was removed this turn
      }
    }
    return last;
  };

  // True if THIS turn logged any transaction (even if later same-turn-deleted). When true, a
  // correction refers to this message's entries, never to history — so we must NOT fall through
  // to the snapshot (which would clobber an unrelated historical row).
  const turnLoggedSomething = (): boolean =>
    ctx
      .peekWrites()
      .some((w) => w.type === "expense" || w.type === "income" || w.type === "goalContribution");

  const deleteLast = tool({
    description: "Delete the most recent transaction. For 'delete that', 'scratch that', 'undo'.",
    inputSchema: z.object({}),
    execute: () => {
      const sameTurn = lastBufferedTx();
      if (sameTurn) {
        ctx.addWrite({ type: "deleteLast", userId: ctx.userId, targetSameTurn: true });
        return {
          ok: true,
          deleted: {
            amount: formatPHP(sameTurn.amountCentavos),
            category: sameTurn.category,
            note: sameTurn.note,
          },
        };
      }
      // This turn logged then already removed its entries — nothing left to delete; never touch history.
      if (turnLoggedSomething()) return { ok: false, error: "nothing to delete" };
      const last = ctx.lastTransaction;
      if (!last) return { ok: false, error: "nothing to delete" };
      ctx.addWrite({ type: "deleteLast", userId: ctx.userId, targetId: last.id });
      return {
        ok: true,
        deleted: {
          amount: formatPHP(last.amountCentavos),
          category: last.category,
          note: last.note,
        },
      };
    },
  });

  const editLast = tool({
    description:
      "Edit the most recent transaction. 'make that 200' → amount:'200'; 'change it to Food' → category:'Food'. Populate at least one field. Amount EXACTLY as written.",
    inputSchema: z.object({
      amount: amount.optional(),
      category: category.optional(),
      note: z.string().optional(),
    }),
    execute: ({ amount: amt, category, note }) => {
      const sameTurn = lastBufferedTx();
      // If the turn logged something, only that is editable; never fall through to history.
      const snapshot = turnLoggedSomething() ? null : ctx.lastTransaction;
      const target = sameTurn ?? snapshot;
      if (!target) return { ok: false, error: "nothing to edit" };
      const patch: {
        amountCentavos?: number;
        category?: (typeof CATEGORIES)[number];
        note?: string;
      } = {};
      if (amt) {
        const r = parseAmount(amt);
        if (!r.ok) return { ok: false, error: r.reason };
        patch.amountCentavos = r.centavos;
      }
      if (category) patch.category = coerceCategory(category);
      // Use `!== undefined` (not truthiness) so an explicit empty string clears the note;
      // the schema marks note optional, so an omitted field stays undefined and is ignored.
      if (note !== undefined) patch.note = note;
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: "no change specified — pass the new amount, category, or note" };
      }
      if (sameTurn) {
        ctx.addWrite({ type: "editLast", userId: ctx.userId, targetSameTurn: true, patch });
      } else if (snapshot) {
        // sameTurn is null, so target === snapshot (the cross-turn historical row).
        ctx.addWrite({ type: "editLast", userId: ctx.userId, targetId: snapshot.id, patch });
      }
      // Project the post-edit row for the reply from whichever row we're actually editing.
      return {
        ok: true,
        updated: {
          amount: formatPHP(patch.amountCentavos ?? target.amountCentavos),
          category: patch.category ?? target.category,
          note: patch.note ?? target.note,
        },
      };
    },
  });

  // ── insights ─────────────────────────────────────────────
  const insights = tool({
    description:
      "Spending insights: weekday vs weekend + biggest leak, this month or a past month. For 'where's my money leaking', 'any patterns'.",
    inputSchema: z.object({ month }),
    execute: async ({ month }) => {
      const { at, label } = resolveMonthAt(month);
      const i = await getInsights(ctx.userId, at ?? new Date());
      return {
        weekend: formatPHP(i.weekendCentavos),
        weekday: formatPHP(i.weekdayCentavos),
        topLeak: i.topLeak
          ? { what: i.topLeak.note ?? "uncategorized", total: formatPHP(i.topLeak.centavos) }
          : null,
        month: label,
      };
    },
  });

  const compareSpending = tool({
    description:
      "Compare total spending between two months to spot a trend. For 'am i spending more than last month', 'how does this month compare to april'. Defaults to this month vs last month.",
    inputSchema: z.object({
      current: month.describe("the more recent month as YYYY-MM; omit for this month"),
      previous: month.describe("the baseline month as YYYY-MM; omit for last month"),
      category: category
        .optional()
        .describe("limit the comparison to one category; omit for all spending"),
    }),
    execute: async ({ current, previous, category }) => {
      // Resolve the two anchors. Defaults: current = this month, previous = the month before it.
      const curAt = current ? (monthAnchor(current) ?? new Date()) : new Date();
      const prevAt = previous
        ? (monthAnchor(previous) ?? prevMonthAnchor(curAt))
        : prevMonthAnchor(curAt);
      const cat = category ? coerceCategory(category) : null;
      // Per-category uses the category sum; all-spending uses month EXPENSE (not net) so the trend
      // reflects outflow, which is what "spending more" means.
      const monthExpense = async (at: Date) => (await getMonthOverview(ctx.userId, at)).expense;
      const [cur, prev] = await Promise.all([
        cat ? sumByCategory(ctx.userId, cat, curAt) : monthExpense(curAt),
        cat ? sumByCategory(ctx.userId, cat, prevAt) : monthExpense(prevAt),
      ]);
      const d = spendingDelta(cur, prev);
      return {
        scope: cat ?? "all spending",
        current: formatPHP(d.current),
        previous: formatPHP(d.previous),
        change: `${d.delta >= 0 ? "+" : "-"}${formatPHP(Math.abs(d.delta))}`,
        pctChange: d.pctChange,
        direction: d.direction,
      };
    },
  });

  const searchHistory = tool({
    description:
      "Search past transactions by keyword, category, amount range, or recency. For 'find that grab last week', 'what was my biggest expense this month', 'anything over 1k on food'. Use byAmount for 'biggest/largest'.",
    inputSchema: z.object({
      text: z.string().optional().describe("keyword to match in the note, e.g. 'grab', 'jollibee'"),
      category: category.optional(),
      month: month.describe("limit to a month as YYYY-MM; omit for all time"),
      minAmount: amount.optional().describe("only entries at least this much, token as written"),
      maxAmount: amount.optional().describe("only entries at most this much"),
      kind: z.enum(["expense", "income"]).optional(),
      byAmount: z
        .boolean()
        .optional()
        .describe("true to sort biggest-first (for 'largest/biggest')"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    execute: async ({ text, category, month, minAmount, maxAmount, kind, byAmount, limit }) => {
      const range = month ? monthAnchor(month) : null;
      const win = range ? monthRange(range) : null;
      const min = minAmount ? parseAmount(minAmount) : null;
      const max = maxAmount ? parseAmount(maxAmount) : null;
      if (min && !min.ok) return { ok: false, error: min.reason };
      if (max && !max.ok) return { ok: false, error: max.reason };
      const rows = await searchTransactions(ctx.userId, {
        text,
        category: category ? coerceCategory(category) : undefined,
        startDate: win?.start,
        endDate: win?.end,
        minCentavos: min?.ok ? min.centavos : undefined,
        maxCentavos: max?.ok ? max.centavos : undefined,
        kind,
        byAmount,
        limit,
      });
      return {
        ok: true,
        count: rows.length,
        transactions: rows.map((r) => ({
          kind: r.kind,
          amount: formatPHP(r.amountCentavos),
          category: r.category,
          note: r.note,
          date: r.localDate,
        })),
      };
    },
  });

  const getSpendingPace = tool({
    description:
      "Project this month's spending to month-end at the current rate and flag a budget it's on track to blow. For 'am i gonna blow my food budget', 'how's my pace this month', 'will i overspend'. Current month only.",
    inputSchema: z.object({ category }),
    execute: async ({ category }) => {
      const cat = coerceCategory(category);
      const now = new Date();
      const [spent, statuses] = await Promise.all([
        sumByCategory(ctx.userId, cat, now),
        budgetStatuses(ctx.userId, now),
      ]);
      const limit = statuses.find((s) => s.category === cat)?.limit ?? 0;
      const v = spendingPace(spent, localDayOfMonth(now), daysInLocalMonth(now), limit);
      return {
        category: cat,
        spentSoFar: formatPHP(v.spentSoFar),
        projectedMonthEnd: formatPHP(v.projected),
        budget: v.limit > 0 ? formatPHP(v.limit) : null,
        onTrackToExceed: v.willExceed,
        projectedOver: v.willExceed ? formatPHP(v.projectedOver) : null,
      };
    },
  });

  // ── recurring bills ──────────────────────────────────────
  const addRecurringBill = tool({
    description:
      "Set up a recurring bill/income reminder (NOT auto-logged). For 'rent 8k every 1st', 'sweldo on the 15th and 30th' (once per date).",
    inputSchema: z.object({
      label: z.string().describe("e.g. 'rent', 'load', 'netflix'"),
      amount,
      category,
      kind: z.enum(["expense", "income"]).default("expense"),
      cadence: z.enum(["weekly", "monthly"]),
      dayOfMonth: z.number().int().min(1).max(31).optional().describe("for monthly"),
      dayOfWeek: z.number().int().min(0).max(6).optional().describe("0=Sun..6=Sat, weekly"),
    }),
    execute: ({ label, amount: amt, category, kind, cadence, dayOfMonth, dayOfWeek }) => {
      const r = parseAmount(amt);
      if (!r.ok) return { ok: false, error: r.reason };
      ctx.addWrite({
        type: "addRecurring",
        userId: ctx.userId,
        recurring: {
          label,
          kind,
          amountCentavos: r.centavos,
          category: coerceCategory(category),
          cadence,
          dayOfMonth: dayOfMonth ?? null,
          dayOfWeek: dayOfWeek ?? null,
        },
      });
      return { ok: true, label, amount: formatPHP(r.centavos), cadence };
    },
  });

  const listRecurringBills = tool({
    description: "List recurring bills/income. For 'what are my recurring bills'.",
    inputSchema: z.object({}),
    execute: async () => {
      const items = await listRecurring(ctx.userId);
      return {
        recurring: items.map((it) => ({
          label: it.label,
          amount: formatPHP(it.amountCentavos),
          category: it.category,
          cadence: it.cadence,
          when: it.cadence === "monthly" ? `day ${it.dayOfMonth}` : `dow ${it.dayOfWeek}`,
        })),
      };
    },
  });

  // ── budgets ──────────────────────────────────────────────
  const setBudget = tool({
    description:
      "Set/update a monthly budget for ONE category. For 'budget 5k for food', 'cap shopping at 3k a month'.",
    inputSchema: z.object({
      category,
      monthlyLimit: amount,
    }),
    execute: ({ category, monthlyLimit }) => {
      const r = parseAmount(monthlyLimit);
      if (!r.ok) return { ok: false, error: r.reason };
      ctx.addWrite({
        type: "setBudget",
        userId: ctx.userId,
        category: coerceCategory(category),
        monthlyLimitCentavos: r.centavos,
      });
      return { ok: true, category, monthlyLimit: formatPHP(r.centavos) };
    },
  });

  const getBudgets = tool({
    description:
      "List every category budget with spent / limit / % used, this month or a past month. For 'how are my budgets', 'am i within budget', 'budget check', 'how were my budgets in may'.",
    inputSchema: z.object({ month }),
    execute: async ({ month }) => {
      const { at, label } = resolveMonthAt(month);
      const rows = await budgetStatuses(ctx.userId, at ?? new Date());
      const real = rows.filter((b) => b.limit > 0);
      return {
        budgets: real.map((b) => ({
          category: b.category,
          spent: formatPHP(b.spent),
          limit: formatPHP(b.limit),
          pct: Math.round((b.spent / b.limit) * 100),
          left: formatPHP(Math.max(0, b.limit - b.spent)),
          over: b.spent > b.limit,
        })),
        month: label,
      };
    },
  });

  const removeBudget = tool({
    description:
      "Remove a category's monthly budget. For 'drop the food budget', 'stop tracking my shopping budget', 'remove budget for transport'.",
    inputSchema: z.object({ category }),
    execute: ({ category }) => {
      const cat = coerceCategory(category);
      ctx.addWrite({ type: "removeBudget", userId: ctx.userId, category: cat });
      return { ok: true, removed: cat };
    },
  });

  const removeRecurringBill = tool({
    description:
      "Remove a recurring bill/income reminder by name. For 'cancel my netflix reminder', 'stop reminding me about rent', 'remove the load reminder'.",
    inputSchema: z.object({
      label: z.string().describe("name of the bill to remove, e.g. 'netflix', 'rent'"),
    }),
    execute: async ({ label }) => {
      // Resolve at tool time for a useful reply ("no reminder matching X"); the same fuzzy match runs
      // again in flushWrites against the live row so a concurrent change can't delete the wrong one.
      const hit = await findRecurringByLabel(ctx.userId, label);
      if (!hit) return { ok: false, error: `no recurring reminder matching "${label}".` };
      ctx.addWrite({ type: "removeRecurring", userId: ctx.userId, match: label });
      return { ok: true, removed: hit.label };
    },
  });

  const editRecurringBill = tool({
    description:
      "Change an existing recurring bill/income reminder: amount, category, cadence, or which day. For 'change rent to 9k', 'move netflix to the 5th', 'make load weekly on fridays'. Populate at least one field besides the name.",
    inputSchema: z.object({
      label: z.string().describe("name of the bill to change, e.g. 'rent', 'netflix'"),
      amount: amount.optional(),
      category: category.optional(),
      cadence: z.enum(["weekly", "monthly"]).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional().describe("for monthly"),
      dayOfWeek: z.number().int().min(0).max(6).optional().describe("0=Sun..6=Sat, weekly"),
    }),
    execute: async ({ label, amount: amt, category, cadence, dayOfMonth, dayOfWeek }) => {
      const hit = await findRecurringByLabel(ctx.userId, label);
      if (!hit) return { ok: false, error: `no recurring reminder matching "${label}".` };
      const patch: {
        amountCentavos?: number;
        category?: Category;
        cadence?: "weekly" | "monthly";
        dayOfMonth?: number | null;
        dayOfWeek?: number | null;
      } = {};
      if (amt !== undefined) {
        const r = parseAmount(amt);
        if (!r.ok) return { ok: false, error: r.reason };
        patch.amountCentavos = r.centavos;
      }
      if (category !== undefined) patch.category = coerceCategory(category);
      if (dayOfMonth !== undefined) patch.dayOfMonth = dayOfMonth;
      if (dayOfWeek !== undefined) patch.dayOfWeek = dayOfWeek;
      if (cadence !== undefined) {
        patch.cadence = cadence;
        // Switching cadence requires the day for the NEW cadence, and clears the old one — otherwise
        // the row keeps a stale dayOfMonth with a null dayOfWeek (or vice versa) and dueRecurringToday
        // silently never fires it again.
        if (cadence === "weekly") {
          if (dayOfWeek === undefined) {
            return { ok: false, error: "switching to weekly needs a day of week (0=Sun..6=Sat)" };
          }
          patch.dayOfMonth = null;
        } else {
          if (dayOfMonth === undefined) {
            return { ok: false, error: "switching to monthly needs a day of month (1-31)" };
          }
          patch.dayOfWeek = null;
        }
      }
      if (Object.keys(patch).length === 0) {
        return {
          ok: false,
          error: "no change specified — pass a new amount, category, cadence, or day",
        };
      }
      ctx.addWrite({ type: "editRecurring", userId: ctx.userId, match: label, patch });
      return {
        ok: true,
        label: hit.label,
        ...(patch.amountCentavos != null ? { amount: formatPHP(patch.amountCentavos) } : {}),
        ...(patch.category != null ? { category: patch.category } : {}),
        ...(patch.cadence ? { cadence: patch.cadence } : {}),
        ...(patch.dayOfMonth != null ? { dayOfMonth: patch.dayOfMonth } : {}),
        ...(patch.dayOfWeek != null ? { dayOfWeek: patch.dayOfWeek } : {}),
      };
    },
  });

  return {
    logExpense,
    logIncome,
    getSpending,
    getOverview,
    getCategoryBreakdown,
    getRecent,
    createGoal,
    contributeToGoal,
    getGoalStatus,
    editGoal,
    deleteGoal,
    remember,
    forgetMemory,
    listMemory,
    deleteLast,
    editLast,
    insights,
    compareSpending,
    searchHistory,
    getSpendingPace,
    addRecurringBill,
    listRecurringBills,
    removeRecurringBill,
    editRecurringBill,
    setBudget,
    getBudgets,
    removeBudget,
  };
}

export type FinanceTools = ReturnType<typeof buildTools>;
