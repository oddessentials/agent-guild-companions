// The desktop's two places, standing in for the Yard's station and plaza: the character works where
// it was put, and rests a short walk away, on the side with more screen.

/** The monitor holding the window's middle at this spot, or else the nearest one. `size` is in CSS pixels. */
export function screenFor({ x, y }, size, monitors) {
  const away = ({ workArea: { position, size: area }, scaleFactor }) => {
    const mx = x + (size.width * scaleFactor) / 2;
    const my = y + (size.height * scaleFactor) / 2;
    return Math.hypot(
      Math.max(position.x - mx, 0, mx - (position.x + area.width - 1)),
      Math.max(position.y - my, 0, my - (position.y + area.height - 1)),
    );
  };
  return monitors.reduce((best, each) => (best && away(best) <= away(each) ? best : each), null);
}

/**
 * The window's left edge at its two places, and their shared top, from where it was put and as which place.
 * The other place is a walk toward the middle of the same monitor, kept on it. With `clamp`, the place it
 * was put is moved just enough to be wholly on that monitor; the placement itself is never changed.
 */
export function placesFor({ x, y, role }, size, distance, monitors, clamp) {
  const monitor = screenFor({ x, y }, size, monitors);
  if (!monitor) return { work: x, rest: x, y };
  const { workArea: { position, size: area }, scaleFactor } = monitor;
  const width = Math.round(size.width * scaleFactor);
  const height = Math.round(size.height * scaleFactor);
  const within = (value, start, length, extent) => Math.max(start, Math.min(value, start + length - extent));
  const at = clamp
    ? { x: within(x, position.x, area.width, width), y: within(y, position.y, area.height, height) }
    : { x, y };
  const side = at.x + width / 2 < position.x + area.width / 2 ? 1 : -1;
  const other = within(at.x + side * Math.round(distance * scaleFactor), position.x, area.width, width);
  return role === 'rest' ? { work: other, rest: at.x, y: at.y } : { work: at.x, rest: other, y: at.y };
}

/** What was saved: a placement, a spot from before placements, nothing, or a record this version must leave alone. */
export function readPlacement(text) {
  if (text === null) return null;
  let saved;
  try { saved = JSON.parse(text); } catch { return { unknown: true }; }
  const whole = (value) => Number.isInteger(value);
  const place = (value) => value === 'work' || value === 'rest';
  if (saved?.v === undefined && whole(saved?.x) && whole(saved?.y)) return { legacy: { x: saved.x, y: saved.y } };
  if (saved?.v === 2 && whole(saved.x) && whole(saved.y) && place(saved.role) && place(saved.at)) {
    return { placement: { x: saved.x, y: saved.y, role: saved.role }, at: saved.at };
  }
  return { unknown: true };
}

/** How far to move this frame, never past the target. */
export function stepToward(x, target, speed, dt) {
  const left = target - x;
  const step = speed * dt;
  return Math.abs(left) <= step ? target : x + Math.sign(left) * step;
}
