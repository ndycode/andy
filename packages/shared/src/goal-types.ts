export interface GoalProgressInput {
  name: string;
  savedCentavos: number;
  targetCentavos: number;
  createdAt: Date;
  today: Date;
  targetDate: Date | null;
}

export interface GoalPaceVerdict {
  /** Saved / target, rounded to a whole percent. */
  pct: number;
  /** True when a deadline is set; only then are onTrack/perWeek meaningful. */
  hasDeadline: boolean;
  /** Saved-fraction >= elapsed-fraction. Reported true when hasDeadline is false. */
  onTrack: boolean;
  /** Suggested weekly save to still hit the deadline; null when on track or no deadline. */
  perWeekCentavos: number | null;
}
