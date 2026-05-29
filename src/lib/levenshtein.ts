// Расстояние Левенштейна (insertion/deletion/substitution = 1).
// Реализация O(n*m), достаточно для коротких имён персонажей.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev: number[] = new Array(b.length + 1);
  let curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(
        prev[j + 1]! + 1, // удаление
        curr[j]! + 1, // вставка
        prev[j]! + cost, // замена
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

// Сходство в диапазоне [0, 1] на основе нормализованного расстояния Левенштейна.
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}
