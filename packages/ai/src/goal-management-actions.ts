import { formatPHP, parseAmount } from "@repo/shared/money";
import { validateCalendarDate } from "@repo/shared/time";
import type { ToolContext } from "./context";
import { type GoalListDeps, loadGoalActionDeps } from "./goal-action-deps";

type EditGoalInput = {
  readonly goalName: string;
  readonly newName?: string;
  readonly target?: string;
  readonly targetDate?: string;
};

type DeleteGoalInput = {
  readonly goalName: string;
};

type GoalPatch = {
  name?: string;
  targetCentavos?: number;
  targetDate?: string | null;
};

export async function editSavingsGoal(
  ctx: ToolContext,
  { goalName, newName, target, targetDate }: EditGoalInput,
  deps?: GoalListDeps,
) {
  const actionDeps = deps ?? (await loadGoalActionDeps());
  // Use findGoalsByName (not findGoalByName) so an AMBIGUOUS match asks "which one?" instead of
  // silently editing an arbitrary goal — same disambiguation deleteSavingsGoal already uses.
  const matches = await actionDeps.findGoalsByName(ctx.userId, goalName);
  if (matches.length === 0) return { ok: false, error: `no goal matching "${goalName}".` };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `which one? ${matches.map((g) => `"${g.name}"`).join(", ")} — say the exact name.`,
    };
  }
  const [goal] = matches;
  if (!goal) return { ok: false, error: `no goal matching "${goalName}".` };
  const patch: GoalPatch = {};
  if (newName !== undefined) {
    const nm = newName.trim();
    if (!nm) return { ok: false, error: "the new name can't be empty" };
    patch.name = nm;
  }
  if (target !== undefined) {
    const r = parseAmount(target);
    if (!r.ok) return { ok: false, error: r.reason };
    patch.targetCentavos = r.centavos;
  }
  if (targetDate !== undefined) {
    const t = targetDate.trim().toLowerCase();
    if (t === "none" || t === "clear" || t === "") patch.targetDate = null;
    else {
      const dv = validateCalendarDate(targetDate);
      if (!dv.ok) return { ok: false, error: `deadline ${dv.reason} (use YYYY-MM-DD or 'none')` };
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
}

export async function deleteSavingsGoal(
  ctx: ToolContext,
  { goalName }: DeleteGoalInput,
  deps?: GoalListDeps,
) {
  const actionDeps = deps ?? (await loadGoalActionDeps());
  const matches = await actionDeps.findGoalsByName(ctx.userId, goalName);
  if (matches.length === 0) return { ok: false, error: `no goal matching "${goalName}".` };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `which one? ${matches.map((g) => `"${g.name}"`).join(", ")} — say the exact name.`,
    };
  }
  const [goal] = matches;
  if (!goal) return { ok: false, error: `no goal matching "${goalName}".` };
  ctx.addWrite({ type: "deleteGoal", userId: ctx.userId, goalId: goal.id });
  return { ok: true, deleted: goal.name };
}
