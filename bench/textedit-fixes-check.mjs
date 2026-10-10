// The fixture is Helvetica Bold, 14 pt, RGB 220/255 red. Missing reads never count as equality.
export function textEditFormatPreserved(initial, final, saved) {
  const valid = c => c?.font === 'Helvetica-Bold' && c.size === 14 && Array.isArray(c.rgba) && c.rgba.length === 4 &&
    c.rgba.every((value, i) => Number.isFinite(value) && Math.abs(value - [220 / 255, 0, 0, 1][i]) < 0.001);
  return [[initial, [0, 4]], [final, [11, 15]], [saved, [11, 15]]].every(([state, indexes]) =>
    indexes.every(index => valid(state?.characters?.find(c => c.index === index))));
}
