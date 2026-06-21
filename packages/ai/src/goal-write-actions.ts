import { formatPHP, parseAmount } from "@repo/shared/money";
import { validateCalendarDate } from "@repo/shared/time";
import type { ToolContext } from "./context";
import { type GoalLookupDeps, loadGoalActionDeps } from "./goal-action-deps";
import { resolveLogDate } from "./tool-resolvers";

type CreateGoalInput = {
  readonly name: string;
  readonly target: string;
  readonly targetDate?: string;
};

type ContributeGoalInput = {
  readonly goalName: string;
  readonly amount: string;
  readonly date?: string;
};

export function createSavingsGoal(ctx: ToolContext, { name, target, targetDate }: CreateGoalInput) {
  if (!name.trim()) return { ok: false, error: "what should i call this goal?" };
  const r = parseAmount(target);
  if (!r.ok) return { ok: false, error: r.reason };
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
}

export async function contributeToSavingsGoal(
  ctx: ToolContext,
  { goalName, amount, date }: ContributeGoalInput,
  deps?: GoalLookupDeps,
) {
  const actionDeps = deps ?? (await loadGoalActionDeps());
  const r = parseAmount(amount);
  if (!r.ok) return { ok: false, error: r.reason };
  const d = resolveLogDate(date, ctx.today);
  if (!d.ok) return { ok: false, error: d.error };
  const goal = await actionDeps.findGoalByName(ctx.userId, goalName);
  if (!goal) {
    const q = goalName.trim().toLowerCase();
    const justCreated = ctx
      .peekWrites()
      .some((w) => w.type === "createGoal" && w.name.trim().toLowerCase().includes(q));
    if (justCreated) {
      return {
        ok: false,
        error: `just created "${goalName}" — send the amount again (e.g. "put 5k in ${goalName}") and i'll add it.`,
      };
    }
    return { ok: false, error: `no goal matching "${goalName}". create it first.` };
  }
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
}
