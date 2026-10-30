import { describe, expect, it } from "vitest";
import { formatCommitDate, localDayKey, previousDay } from "./commit-date";

const LABELS = { today: "Hoje", yesterday: "Ontem" };

/**
 * Instante em horário local. Passar ISO com offset fixo faria o teste depender
 * do fuso da máquina/CI; assim o "13:30" é sempre 13:30 onde o teste rodar.
 */
function localIso(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

describe("formatCommitDate", () => {
  it("mostra Hoje com o horário do commit", () => {
    const reference = new Date(2026, 9, 29, 9, 15);

    expect(formatCommitDate(localIso(2026, 10, 29, 13, 30), "pt-BR", reference, LABELS)).toBe(
      "Hoje, 13:30",
    );
  });

  it("mostra Ontem para o dia anterior", () => {
    const reference = new Date(2026, 9, 29, 9, 15);

    expect(formatCommitDate(localIso(2026, 10, 28, 17, 4), "pt-BR", reference, LABELS)).toBe(
      "Ontem, 17:04",
    );
  });

  it("mostra a data absoluta para commits mais antigos", () => {
    const reference = new Date(2026, 9, 29, 9, 15);

    expect(formatCommitDate(localIso(2026, 10, 27, 9, 12), "pt-BR", reference, LABELS)).toBe(
      "27/10/26, 09:12",
    );
  });

  it("troca Hoje por Ontem quando a data de referência vira o dia", () => {
    const commit = localIso(2026, 10, 28, 23, 59);
    const beforeMidnight = new Date(2026, 9, 28, 23, 59, 30);
    const afterMidnight = new Date(2026, 9, 29, 0, 0, 30);

    expect(formatCommitDate(commit, "pt-BR", beforeMidnight, LABELS)).toBe("Hoje, 23:59");
    expect(formatCommitDate(commit, "pt-BR", afterMidnight, LABELS)).toBe("Ontem, 23:59");
  });

  it("traduz os rótulos conforme o idioma", () => {
    const reference = new Date(2026, 9, 29, 9, 15);
    const label = formatCommitDate(localIso(2026, 10, 29, 13, 30), "en", reference, {
      today: "Today",
      yesterday: "Yesterday",
    });

    expect(label).toMatch(/^Today, 0?1:30\sPM$/);
  });

  it("devolve a entrada quando a data é inválida", () => {
    expect(formatCommitDate("nao-e-data", "pt-BR", new Date(), LABELS)).toBe("nao-e-data");
  });
});

describe("localDayKey", () => {
  it("formata o dia local com zero à esquerda", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("previousDay", () => {
  it("volta para o ano anterior em 1º de janeiro", () => {
    expect(localDayKey(previousDay(new Date(2026, 0, 1, 0, 30)))).toBe("2025-12-31");
  });

  it("volta para o mês anterior em 1º de março", () => {
    expect(localDayKey(previousDay(new Date(2026, 2, 1, 12, 0)))).toBe("2026-02-28");
  });
});
