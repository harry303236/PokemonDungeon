/** Draw pose between the previous fixed step and the current one.
 *  alpha is leftover accumulator / FIXED_DT: 0 draws the previous step (one tick behind, continuous).
 *  Teleports and floor changes snap instead of sliding across the map. */
export function renderPose(
  prev: { x: number; y: number } | undefined,
  curr: { x: number; y: number },
  alpha: number,
  snapDist = 96,
): { x: number; y: number } {
  if (!prev) return { x: curr.x, y: curr.y };
  const dx = curr.x - prev.x;
  const dy = curr.y - prev.y;
  if (dx * dx + dy * dy > snapDist * snapDist) return { x: curr.x, y: curr.y };
  return { x: prev.x + dx * alpha, y: prev.y + dy * alpha };
}
