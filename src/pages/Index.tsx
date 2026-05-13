import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import UploadZone from "@/components/UploadZone";
import ProcessingStatus, { type ProcessingStep } from "@/components/ProcessingStatus";
import ResultsPanel from "@/components/ResultsPanel";
import { runAnalysisPipeline, type AnalysisResult } from "@/lib/analysis";
import { usePersistentState } from "@/hooks/usePersistentState";

interface OfflineAnalysisState {
  step: ProcessingStep | null;
  error?: string;
  clipId?: string;
  fileUrl?: string;
  result?: AnalysisResult;
}

const initialOfflineState: OfflineAnalysisState = {
  step: null,
};

const Index = () => {
  const [analysisState, setAnalysisState, clearAnalysisState] = usePersistentState(
    "vision2voice.offlineAnalysis.v1",
    initialOfflineState,
  );
  const [isRegenerating, setIsRegenerating] = useState(false);
  const { step, error, clipId, fileUrl, result } = analysisState;

  const processVideo = useCallback(async (file: File) => {
    setAnalysisState({ step: "uploading" });

    try {
      const fileName = `${Date.now()}_${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("videos")
        .upload(fileName, file);
      if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

      const { data: urlData } = supabase.storage
        .from("videos")
        .getPublicUrl(fileName);
      const publicUrl = urlData.publicUrl;

      setAnalysisState({ step: "processing" });
      const { data: clip, error: clipError } = await supabase
        .from("clips")
        .insert({ title: file.name, file_url: publicUrl })
        .select()
        .single();
      if (clipError || !clip) throw new Error("Failed to save clip record");

      setAnalysisState({ step: "processing", clipId: clip.id, fileUrl: publicUrl });

      setAnalysisState({ step: "detecting", clipId: clip.id, fileUrl: publicUrl });
      await delay(800);
      setAnalysisState({ step: "retrieving", clipId: clip.id, fileUrl: publicUrl });
      await delay(600);
      setAnalysisState({ step: "generating", clipId: clip.id, fileUrl: publicUrl });

      const payload = await runAnalysisPipeline(clip.id, publicUrl);
      setAnalysisState({ step: "complete", clipId: clip.id, fileUrl: publicUrl, result: payload });
    } catch (err: unknown) {
      setAnalysisState((current) => ({
        ...current,
        error: err instanceof Error ? err.message : "Something went wrong",
        step: "error",
      }));
    }
  }, [setAnalysisState]);

  const handleRegenerate = useCallback(async () => {
    if (!clipId || !fileUrl) return;
    setIsRegenerating(true);
    try {
      const payload = await runAnalysisPipeline(clipId, fileUrl, "regenerate");
      setAnalysisState((current) => ({ ...current, result: payload, step: "complete" }));
    } catch {
      // keep existing result
    } finally {
      setIsRegenerating(false);
    }
  }, [clipId, fileUrl, setAnalysisState]);

  const reset = () => {
    clearAnalysisState();
  };

  const isProcessing = !!step && step !== "complete" && step !== "error";

  return (
    <div className="local-minima-bg flex min-h-screen flex-col text-foreground">
      <main className="relative mx-auto w-full max-w-[1400px] px-6 pb-12 pt-40 sm:px-10 sm:pt-48">
        <div className="absolute right-6 top-8 flex flex-wrap items-center justify-end gap-3 sm:right-10 sm:top-10">
          <Link
            to="/about"
            className="inline-flex items-center gap-2 border border-foreground/40 px-5 py-3 font-mono text-[11px] uppercase tracked tabular text-foreground transition-colors hover:bg-foreground hover:text-background"
          >
            About
          </Link>
          <Link
            to="/live"
            className="group inline-flex items-center gap-3 border border-foreground/40 px-5 py-3 font-mono text-[11px] uppercase tracked tabular text-foreground transition-colors hover:bg-foreground hover:text-background"
          >
            <span className="h-2 w-2 animate-live-blink bg-court" aria-hidden />
            <span>Live Replay</span>
            <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </Link>
        </div>

        <section className="grid justify-items-center gap-5 text-center">
          <div>
            <h1 className="title-gradient font-display text-[clamp(56px,8.8vw,96px)] leading-[0.9]">
              VISION2VOICE
            </h1>
            <p className="mt-4 max-w-[760px] font-body text-sm italic text-foreground/80 sm:text-base">
              A quiet desk for live and replay moments, where every possession can unfold into a clearer story.
            </p>
          </div>
        </section>

        <section className="mt-14 sm:mt-16">
          <UploadZone onFileSelect={processVideo} isProcessing={isProcessing || !!result} />
        </section>

        {step && step !== "complete" && (
          <section className="mt-12 flex justify-center">
            <ProcessingStatus currentStep={step} error={error} />
          </section>
        )}

        {result && clipId && fileUrl && (
          <section className="mt-16">
            <ResultsPanel
              clipId={clipId}
              fileUrl={fileUrl}
              result={result}
              onRegenerate={handleRegenerate}
              isRegenerating={isRegenerating}
            />
          </section>
        )}

        {result && (
          <div className="mt-16 flex items-center gap-4 border-t border-foreground/40 pt-6">
            <button
              type="button"
              onClick={reset}
              className="font-mono text-[11px] uppercase tracked tabular text-foreground underline decoration-court decoration-2 underline-offset-[6px] transition-opacity hover:opacity-70"
            >
              FILE A NEW CLIP →
            </button>
          </div>
        )}
      </main>
    </div>
  );
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default Index;
