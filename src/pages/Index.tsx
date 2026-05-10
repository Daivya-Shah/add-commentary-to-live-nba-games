import { useState, useCallback, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import UploadZone from "@/components/UploadZone";
import ResultsPanel from "@/components/ResultsPanel";
import {
  uploadAndAnalyzeStream,
  useDirectBackend,
  type AnalysisResult,
  type PossessionSegment,
} from "@/lib/analysis";

type Phase = "idle" | "uploading" | "analyzing" | "complete" | "error";

const Index = () => {
  const [phase,       setPhase]       = useState<Phase>("idle");
  const [statusMsg,   setStatusMsg]   = useState("");
  const [error,       setError]       = useState<string>();
  const [localUrl,    setLocalUrl]    = useState<string | null>(null);
  const [cloudUrl,    setCloudUrl]    = useState<string | null>(null);
  const [result,      setResult]      = useState<AnalysisResult | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const localUrlRef   = useRef<string | null>(null);

  const reset = useCallback(() => {
    if (localUrlRef.current) { URL.revokeObjectURL(localUrlRef.current); localUrlRef.current = null; }
    setPhase("idle"); setResult(null); setLocalUrl(null);
    setCloudUrl(null); setError(undefined); setStatusMsg(""); setIsStreaming(false);
  }, []);

  useEffect(() => () => { if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current); }, []);

  const handleFile = useCallback(async (file: File) => {
    setError(undefined); setResult(null); setPhase("idle"); setStatusMsg("");

    // 1. Instant local playback — video shows immediately, no waiting for upload
    const local = URL.createObjectURL(file);
    setLocalUrl(local);
    localUrlRef.current = local;

    if (!useDirectBackend()) {
      setPhase("error");
      setError("Set VITE_BACKEND_URL in .env and run npm run dev:full to enable analysis.");
      return;
    }

    // 2. Upload to Supabase in background — only needed for voiceover export.
    //    Don't await — runs in parallel. If file is too large, voiceover is just unavailable.
    (async () => {
      try {
        const fileName = `${Date.now()}_${file.name}`;
        const { error: upErr } = await supabase.storage.from("videos").upload(fileName, file);
        if (!upErr) {
          const { data } = supabase.storage.from("videos").getPublicUrl(fileName);
          setCloudUrl(data.publicUrl);
        }
      } catch { /* voiceover unavailable — that's fine */ }
    })();

    // 3. Send file DIRECTLY to backend — no Supabase storage, no file size limit
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    setPhase("uploading");
    setStatusMsg(`Sending ${sizeMb} MB to backend…`);
    setIsStreaming(true);

    try {
      const segments: PossessionSegment[] = [];
      const lines:    string[]            = [];
      let   vBase:    Partial<AnalysisResult> = {};

      for await (const ev of uploadAndAnalyzeStream(file, "local")) {
        if (ev.type === "status") {
          setStatusMsg(ev.message);
          if (phase !== "analyzing") setPhase("analyzing");

        } else if (ev.type === "video_info") {
          const dur = Math.round(ev.duration);
          setStatusMsg(
            ev.total_chunks > 1
              ? `Processing ${dur}s video in ${ev.total_chunks} chunks…`
              : `Analyzing ${dur}s clip…`
          );
          setPhase("analyzing");

        } else if (ev.type === "vision_chunk") {
          segments.push(...ev.segments);
          vBase = {
            ...vBase,
            event_type:     ev.event_type,
            player_name:    ev.player_name,
            team_name:      ev.team_name,
            confidence:     ev.confidence,
            scoreboard:     ev.scoreboard    ?? (vBase as AnalysisResult).scoreboard,
            on_screen_text: ev.on_screen_text ?? (vBase as AnalysisResult).on_screen_text,
          };
          setResult(prev => ({
            ...(prev ?? { commentary_text: "", visual_summary: "" } as AnalysisResult),
            ...(vBase as AnalysisResult),
            possession_timeline:      [...segments],
            segment_commentary_lines: [],
          }));

        } else if (ev.type === "segment") {
          lines[ev.index] = ev.line;
          setResult(prev => prev ? {
            ...prev,
            commentary_text:          lines.filter(Boolean).join(" "),
            segment_commentary_lines: [...lines],
          } : null);

        } else if (ev.type === "complete") {
          setResult({
            ...(vBase as AnalysisResult),
            visual_summary:           ev.visual_summary,
            commentary_text:          ev.commentary_text,
            segment_commentary_lines: ev.segment_commentary_lines,
            possession_timeline:      segments,
            players_stats:            ev.players_stats,
            scoreboard:               ev.scoreboard    ?? (vBase as AnalysisResult).scoreboard,
            on_screen_text:           ev.on_screen_text ?? (vBase as AnalysisResult).on_screen_text,
            model_name:               ev.model_name,
            duration:                 ev.duration,
            chunks_processed:         ev.chunks_processed,
          });
          setPhase("complete");
          setIsStreaming(false);
          setStatusMsg("");
          return;

        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    } catch (err: any) {
      const raw = err?.message ?? "Something went wrong";
      // Give a clear message when the backend simply isn't running
      const msg =
        raw.toLowerCase().includes("fetch") ||
        raw.toLowerCase().includes("network") ||
        raw.toLowerCase().includes("failed to fetch")
          ? "Cannot reach backend. Make sure it is running: open a terminal and run  npm run dev:full"
          : raw;
      setError(msg);
      setPhase("error");
      setIsStreaming(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (localUrl) {
    return (
      <ResultsPanel
        localUrl={localUrl}
        cloudUrl={cloudUrl}
        result={result}
        isStreaming={isStreaming}
        statusMessage={statusMsg}
        error={error}
        phase={phase}
        onReset={reset}
      />
    );
  }

  return (
    <UploadZone
      onFileSelect={handleFile}
      uploading={phase === "uploading"}
      uploadStatus={statusMsg}
    />
  );
};

export default Index;
