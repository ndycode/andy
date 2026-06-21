export function goalPaceNudgeCopy(progress: string) {
  return {
    fallback: `🎯 ${progress}`,
    brief: `The user's savings goal is behind pace: "${progress}". Give a short, encouraging nudge to get back on track. Not preachy.`,
  };
}
