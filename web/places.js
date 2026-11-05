// The desktop's two places, standing in for the Yard's station and plaza: the character works where
// it was put, and rests a short walk away, on the side with more screen.

/** The window's left edge at its two places, given the place it is at now. `area` is the monitor's work area. */
export function placesFrom(x, mode, distance, windowWidth, area) {
  const middle = area.position.x + area.size.width / 2;
  const side = x + windowWidth / 2 < middle ? 1 : -1;
  const other = Math.round(x + side * distance);
  return mode === 'rest' ? { home: other, rest: x } : { home: x, rest: other };
}

/** Whether a window at this spot still has its middle on a connected screen, so a saved spot can't lose it. */
export function isOnScreen(spot, windowWidth, windowHeight, areas) {
  const x = spot.x + windowWidth / 2;
  const y = spot.y + windowHeight / 2;
  return areas.some(({ position, size }) => x >= position.x && x < position.x + size.width && y >= position.y && y < position.y + size.height);
}

/** How far to move this frame, never past the target. */
export function stepToward(x, target, speed, dt) {
  const left = target - x;
  const step = speed * dt;
  return Math.abs(left) <= step ? target : x + Math.sign(left) * step;
}
