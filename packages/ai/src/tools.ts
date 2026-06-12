import {
  findGoalByName,
  getInsights,
  getMonthOverview,
  getRecentTransactions,
  getSpendingByCategory,
  listGoals,
  listRecurring,
  sumByCategory,
} from "@repo/db";
import { CATEGORIES, type Category, coerceCategory } from "@repo/shared/categories";
import { goalProgressMessage } from "@repo/shared/goals";
import { formatPHP, parseAmount } from "@repo/shared/money";
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

  // ── logging ──────────────────────────────────────────────
  const logExpense = tool({
    description: "Log one spending/expense entry. Once per distinct expense.",
    inputSchema: z.object({
      amount,
      category,
      note: z.string().optional().describe("Short label, e.g. 'lunch', 'grab'."),
    }),
    execute: ({ amount, category, note }) => {
      const r = parseAmount(amount);
      if (!r.ok) return { ok: false, error: r.reason };
      ctx.addWrite({
        type: "expense",
        userId: ctx.userId,
        amountCentavos: r.centavos,
        category: coerceCategory(category),
        note,
        localDate: ctx.today,
      });
      return { ok: true, logged: formatPHP(r.centavos), category };
    },
  });

  const logIncome = tool({
    description: "Log an income entry (sweldo, salary, payment received).",
    inputSchema: z.object({ amount, note: z.string().optional() }),
    execute: ({ amount, note }) => {
      const r = parseAmount(amount);
      if (!r.ok) return { ok: false, error: r.reason };
      ctx.addWrite({
        type: "income",
        userId: ctx.userId,
        amountCentavos: r.centavos,
        category: "Income",
        note,
        localDate: ctx.today,
      });
      return { ok: true, logged: formatPHP(r.centavos) };
    },
  });

  // ── questions / reads ────────────────────────────────────
  const getSpending = tool({
    description: "Total spending in ONE category this month.",
    inputSchema: z.object({ category }),
    execute: async ({ category }) => {
      const cat = coerceCategory(category);
      const total = await sumByCategory(ctx.userId, cat);
      return { category: cat, total: formatPHP(total) };
    },
  });

  const getOverview = tool({
    description: "Month income, expenses, and net. For 'how am i doing', 'am i broke'.",
    inputSchema: z.object({}),
    execute: async () => {
      const o = await getMonthOverview(ctx.userId);
      return {
        income: formatPHP(o.income),
        expenses: formatPHP(o.expense),
        net: formatPHP(o.net),
      };
    },
  });

  const getCategoryBreakdown = tool({
    description: "Spending by category this month, biggest first. For 'where's my money going'.",
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await getSpendingByCategory(ctx.userId);
      return { breakdown: rows.map((r) => ({ category: r.category, total: formatPHP(r.total) })) };
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
      ctx.addWrite({
        type: "createGoal",
        userId: ctx.userId,
        name,
        targetCentavos: r.centavos,
        targetDate: targetDate ?? null,
      });
      return { ok: true, name, target: formatPHP(r.centavos), targetDate: targetDate ?? null };
    },
  });

  const contributeToGoal = tool({
    description: "Add money to an existing goal, e.g. 'put 2000 to emergency fund'.",
    inputSchema: z.object({ goalName: z.string(), amount }),
    execute: async ({ goalName, amount }) => {
      const r = parseAmount(amount);
      if (!r.ok) return { ok: false, error: r.reason };
      const goal = await findGoalByName(ctx.userId, goalName);
      if (!goal) return { ok: false, error: `no goal matching "${goalName}". create it first.` };
      ctx.addWrite({
        type: "goalContribution",
        userId: ctx.userId,
        goalId: goal.id,
        amountCentavos: r.centavos,
        localDate: ctx.today,
      });
      const newSaved = goal.savedCentavos + r.centavos;
      return {
        ok: true,
        goal: goal.name,
        added: formatPHP(r.centavos),
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
      const today = new Date();
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
      if (note) patch.note = note;
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
      "Spending insights: weekday vs weekend + biggest leak. For 'where's my money leaking', 'any patterns'.",
    inputSchema: z.object({}),
    execute: async () => {
      const i = await getInsights(ctx.userId);
      return {
        weekend: formatPHP(i.weekendCentavos),
        weekday: formatPHP(i.weekdayCentavos),
        topLeak: i.topLeak
          ? { what: i.topLeak.note ?? "uncategorized", total: formatPHP(i.topLeak.centavos) }
          : null,
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
    remember,
    forgetMemory,
    listMemory,
    deleteLast,
    editLast,
    insights,
    addRecurringBill,
    listRecurringBills,
    setBudget,
  };
}

export type FinanceTools = ReturnType<typeof buildTools>;
