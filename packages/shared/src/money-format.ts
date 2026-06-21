const PHP = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format integer centavos as "₱25,000.00". Division happens only here, at display. */
export function formatPHP(centavos: number): string {
  if (!Number.isInteger(centavos)) {
    throw new Error(`formatPHP expects integer centavos, got ${centavos}`);
  }
  const sign = centavos < 0 ? "-" : "";
  return `${sign}₱${PHP.format(Math.abs(centavos) / 100)}`;
}
