function round(point) {
  return [Math.round(point[0]), Math.round(point[1])];
}

function unique(squares, match) {
  const found = (squares ?? []).filter(square => match(square?.name ?? ''));
  return found.length === 1 ? found[0] : undefined;
}

function center(square) {
  if (Array.isArray(square?.point) && square.point.length >= 2) {
    const x = Number(square.point[0]), y = Number(square.point[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  const frame = square?.frame ?? square?.bounds;
  if (!frame || typeof frame !== 'object') return undefined;
  const x = Number(frame.x ?? frame.X), y = Number(frame.y ?? frame.Y);
  const width = Number(frame.width ?? frame.Width), height = Number(frame.height ?? frame.Height);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return [x + width / 2, y + height / 2];
}

export function chessMovePoints({ bounds, squares, recorded } = {}) {
  const width = Number(bounds?.Width ?? bounds?.width);
  const height = Number(bounds?.Height ?? bounds?.height);
  const e2 = unique(squares, name => /white pawn, e2/.test(name));
  const e4 = unique(squares, name => name === 'e4') ?? unique(squares, name => /(^|,\s*)e4$/.test(name));
  const from = center(e2), to = center(e4);
  if (from && to && Number.isFinite(height) && height > 0) {
    if (from[1] < to[1]) {
      from[1] = height - from[1];
      to[1] = height - to[1];
    }
    return { from: round(from), to: round(to), source: 'ax-frames' };
  }
  const recordedWidth = Number(recorded?.bounds?.Width), recordedHeight = Number(recorded?.bounds?.Height);
  if (![width, height, recordedWidth, recordedHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Chess move points need current and recorded window sizes');
  }
  const sx = width / recordedWidth, sy = height / recordedHeight;
  return {
    from: round([recorded.from[0] * sx, recorded.from[1] * sy]),
    to: round([recorded.to[0] * sx, recorded.to[1] * sy]),
    source: 'scaled',
  };
}
