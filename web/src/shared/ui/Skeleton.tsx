/**
 * A loading placeholder that holds the shape of what is coming, so the surface
 * does not flash a line of text and then jump. The accessible name stays a
 * plain sentence; the bars are decoration.
 */
export function Skeleton({ lines = 3, label = "加载中" }: { lines?: number; label?: string }) {
  return (
    <div className="react-skeleton" role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} style={{ width: `${100 - index * 11}%` }} />
      ))}
    </div>
  );
}
