// The desktop's two places, standing in for the Yard's station and plaza: the character works where
// it was put, and rests a short walk away, on the side with more screen.

/** The window's left edge at its two places, given the place it is at now. `area` is the monitor's work area. */
export function placesFrom(x, mode, distance, windowWidth, area) {
  const middle = area.position.x + area.size.width / 2;
  const side = x + windowWidth / 2 < middle ? 1 : -1;
  const other = Math.round(x + side * distance);
  return mode === 'rest' ? { home: other, rest: x } : { home: x, rest: other };
}

/** How far to move this frame, never past the target. */
export function stepToward(x, target, speed, dt) {
  const left = target - x;
  const step = speed * dt;
  return Math.abs(left) <= step ? target : x + Math.sign(left) * step;
}
