/**
 * Rótulos relativos usados no histórico ("Hoje", "Ontem") dependem do dia em
 * que a tela é vista, não do dia em que o commit foi criado. Por isso o
 * cálculo recebe explicitamente a data de referência: assim o componente
 * consegue recalculá-los quando o dia vira, em vez de congelar o texto que
 * apareceu na primeira renderização.
 */

export interface CommitDateLabels {
  today: string;
  yesterday: string;
}

/** Chave estável do dia local (AAAA-MM-DD), imune a horário de verão. */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Data local de ontem em relação à referência, respeitando meses e anos. */
export function previousDay(reference: Date): Date {
  return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 1);
}

/**
 * "Hoje, 13:30" / "Ontem, 17:04" / "28/10/26, 09:12" (formato conforme idioma).
 * Datas inválidas são devolvidas como vieram para não esconder o dado.
 */
export function formatCommitDate(
  value: string,
  language: string,
  reference: Date,
  labels: CommitDateLabels,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const time = date.toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const day = localDayKey(date);

  if (day === localDayKey(reference)) {
    return `${labels.today}, ${time}`;
  }

  if (day === localDayKey(previousDay(reference))) {
    return `${labels.yesterday}, ${time}`;
  }

  return date.toLocaleString(language, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
