import { Loader2 } from "lucide-react";
import { Marker } from "@/components/almanac";
import { cn } from "@/lib/utils";

export type ProcessingStep =
  | "uploading"
  | "processing"
  | "detecting"
  | "retrieving"
  | "generating"
  | "complete"
  | "error";

interface ProcessingStatusProps {
  currentStep: ProcessingStep;
  error?: string;
}

const PIPELINE_STEPS = [
  { key: "uploading" as const, label: "TRANSMITTING CLIP" },
  { key: "processing" as const, label: "REGISTERING RECORD" },
  { key: "detecting" as const, label: "DETECTING EVENT" },
  { key: "retrieving" as const, label: "RETRIEVING CONTEXT" },
  { key: "generating" as const, label: "WRITING THE CALL" },
] as const;

function stepDisplay(step: ProcessingStep): { ordinal: string; label: string } | null {
  const i = PIPELINE_STEPS.findIndex((s) => s.key === step);
  if (i < 0) return null;
  return { ordinal: String(i + 1).padStart(2, "0"), label: PIPELINE_STEPS[i].label };
}

const ProcessingStatus = ({ currentStep, error }: ProcessingStatusProps) => {
  if (currentStep === "complete" && !error) return null;

  if (error) {
    return (
      <div className="w-full max-w-2xl border-y border-destructive/60 py-5">
        <div className="flex items-baseline justify-between gap-6">
          <Marker tone="accent">FAULT / 500</Marker>
          <span className="font-mono text-[10px] uppercase tracked text-destructive">PROCESSING FAILED</span>
        </div>
        <p className="mt-2 font-body text-sm italic text-foreground/85">{error}</p>
      </div>
    );
  }

  const active = stepDisplay(currentStep);

  return (
    <div
      className="flex flex-col items-center justify-center gap-6 py-8 sm:gap-7"
      aria-live="polite"
      aria-busy="true"
      aria-label={active ? `Step ${active.ordinal}: ${active.label}` : "Loading"}
    >
      <div className="flex min-h-[4.5rem] w-full max-w-2xl items-end justify-center px-4 text-center sm:min-h-[5rem]">
        {active ? (
          <p
            key={currentStep}
            className={cn(
              "font-mono text-base uppercase leading-snug tracking-[0.12em] text-foreground/90 sm:text-lg",
              "animate-in fade-in-0 slide-in-from-bottom-2 duration-300",
            )}
          >
            <span className="text-foreground/45">{active.ordinal}</span>{" "}
            <span className="text-foreground">{active.label}</span>
          </p>
        ) : null}
      </div>

      <Loader2
        className="h-14 w-14 shrink-0 animate-spin text-foreground/70 sm:h-16 sm:w-16"
        strokeWidth={2}
        aria-hidden
      />
    </div>
  );
};

export default ProcessingStatus;
