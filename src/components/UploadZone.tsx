import { useCallback, useState } from "react";
import { Film, Upload } from "lucide-react";

interface UploadZoneProps {
  onFileSelect: (file: File) => void;
  uploading: boolean;
  uploadStatus?: string;
}

const UploadZone = ({ onFileSelect, uploading, uploadStatus }: UploadZoneProps) => {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("video/")) onFileSelect(file);
    },
    [onFileSelect]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFileSelect(file);
    },
    [onFileSelect]
  );

  return (
    <div className="min-h-screen bg-[#09090b] flex flex-col items-center justify-center px-6">
      {/* Logo */}
      <div className="mb-12 text-center">
        <h1 className="font-display text-5xl font-bold tracking-tight text-white">
          Vision<span className="text-primary">2</span>Voice
        </h1>
        <p className="mt-3 text-base text-white/40">
          Upload an NBA clip — AI identifies every player, tracks the ball,
          <br className="hidden sm:block" /> and generates live play-by-play commentary
        </p>
      </div>

      {uploading ? (
        /* Uploading state */
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          <p className="text-sm text-white/50">{uploadStatus || "Uploading…"}</p>
        </div>
      ) : (
        /* Drop zone */
        <>
          <input
            id="file-input"
            type="file"
            accept="video/mp4,video/*"
            className="hidden"
            onChange={handleFileInput}
          />
          <div
            className={`w-full max-w-xl rounded-3xl border-2 border-dashed cursor-pointer transition-all duration-200 p-16 text-center ${
              isDragOver
                ? "border-primary bg-primary/5 scale-[1.01]"
                : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById("file-input")?.click()}
          >
            <div className="flex flex-col items-center gap-5">
              <div className={`rounded-2xl p-5 transition-colors ${isDragOver ? "bg-primary/20" : "bg-white/5"}`}>
                {isDragOver
                  ? <Film className="h-12 w-12 text-primary" />
                  : <Upload className="h-12 w-12 text-white/30" />
                }
              </div>
              <div>
                <p className="text-xl font-semibold text-white">
                  {isDragOver ? "Release to analyze" : "Drop your basketball clip here"}
                </p>
                <p className="mt-1.5 text-sm text-white/40">
                  or <span className="text-primary underline underline-offset-2">click to browse</span> your files
                </p>
              </div>
            </div>
          </div>

          {/* Hints */}
          <div className="mt-8 flex flex-col items-center gap-3 text-center">
            <div className="flex items-center gap-4 text-xs text-white/25">
              <span>MP4 · MOV · AVI</span>
              <span className="h-1 w-1 rounded-full bg-white/20" />
              <span>5 seconds to 2 minutes works best</span>
              <span className="h-1 w-1 rounded-full bg-white/20" />
              <span>NBA broadcast clips preferred</span>
            </div>
            <p className="max-w-sm text-xs text-white/15 leading-relaxed">
              The AI reads jersey numbers frame-by-frame, matches them to live NBA rosters,
              and streams live commentary as you watch.
            </p>
          </div>
        </>
      )}
    </div>
  );
};

export default UploadZone;
