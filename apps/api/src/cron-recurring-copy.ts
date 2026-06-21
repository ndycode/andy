import { formatPHP } from "@repo/shared/money";

interface RecurringReminderCopyInput {
  label: string;
  kind: "expense" | "income";
  amountCentavos: number;
}

export function recurringReminderCopy({ label, kind, amountCentavos }: RecurringReminderCopyInput) {
  const verb = kind === "income" ? "expected today" : "due today";
  return {
    fallback: `🔔 ${label} (${formatPHP(amountCentavos)}) ${verb} — want me to log it?`,
    brief: `Remind the user that "${label}" (${formatPHP(amountCentavos)}) is ${verb}. Offer to log it. Keep it light.`,
  };
}
