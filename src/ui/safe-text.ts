export function safeLiteralText(value: string, maximum = 80): string {
  const withoutUnsafe = [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127 && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069);
  }).join('');
  const points = [...withoutUnsafe];
  return points.length <= maximum ? withoutUnsafe : `${points.slice(0, maximum - 1).join('')}…`;
}
