import { getProgressLabel, getProgressPercent } from "@/lib/bulkImport";

export default function ProgressBar({ progress }) {
  if (!progress) return null;

  const percent = getProgressPercent(progress);
  const label = getProgressLabel(progress);

  return (
    <div className="mt-4">
      <div className="mb-1 flex justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <span>
          {progress.phase === "reading"
            ? `${percent}%`
            : `${progress.done}/${progress.total}`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className="h-full bg-zinc-900 transition-all duration-150 dark:bg-zinc-100"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
