export interface PaletteSearchItem {
  label: string;
  hint: string;
}

/** Remove acentos e caixa para a busca ("configuracoes" acha "Configurações"). */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Filtra itens por todos os termos digitados (em qualquer ordem), olhando
 * rótulo e dica. Sem consulta, devolve os primeiros itens.
 */
export function filterPaletteItems<T extends PaletteSearchItem>(
  items: T[],
  query: string,
  limit: number,
): T[] {
  const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return items.slice(0, limit);
  }

  return items
    .filter((item) => {
      const haystack = normalizeSearch(`${item.label} ${item.hint}`);
      return tokens.every((token) => haystack.includes(token));
    })
    .slice(0, limit);
}
