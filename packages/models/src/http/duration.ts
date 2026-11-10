/** Go `Duration.String()` for whole seconds (`45s`, `1m30s`, `1h0m0s`). */
export const formatDurationSeconds = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  if (hours > 0) return `${hours}h${minutes}m${rest}s`;

  if (minutes > 0) return `${minutes}m${rest}s`;

  return `${rest}s`;
};
