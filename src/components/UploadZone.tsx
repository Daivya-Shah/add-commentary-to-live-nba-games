import { useCallback, useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

interface UploadZoneProps {
  onFileSelect: (file: File) => void;
  isProcessing: boolean;
}

const UploadZone = ({ onFileSelect, isProcessing }: UploadZoneProps) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [hover, setHover] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("video/")) {
        onFileSelect(file);
      }
    },
    [onFileSelect],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFileSelect(file);
    },
    [onFileSelect],
  );

  if (isProcessing) return null;

  return (
    <div className="mx-auto w-full max-w-[1080px] select-none">
      <div
        className={cn(
          "upload-glass-zone group relative cursor-pointer rounded-[10px] bg-transparent transition-all duration-300",
          isDragOver
            ? "shadow-[0_0_34px_rgba(224,184,248,0.52),0_0_74px_rgba(150,210,255,0.36)]"
            : hover
              ? "shadow-[0_0_28px_rgba(218,174,248,0.46),0_0_60px_rgba(150,210,255,0.3)]"
              : "shadow-[0_0_22px_rgba(196,152,244,0.34)]",
        )}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          id="file-input"
          type="file"
          accept="video/mp4,video/*"
          className="hidden"
          onChange={handleFileInput}
        />

        <div className="px-6 pb-10 pt-6 sm:px-8 sm:pb-12 sm:pt-7">
          <div
            className="flex min-h-[190px] flex-col items-center justify-center gap-3 rounded-[8px] border border-white/25 px-6 py-10 text-center sm:min-h-[220px]"
            onClick={() => document.getElementById("file-input")?.click()}
          >
            <div className="inline-flex items-center justify-center rounded-full border border-white/70 p-5">
              <Upload className="h-14 w-14 text-foreground" strokeWidth={2.1} />
            </div>
            <p className="font-body text-xs text-white sm:text-sm">
              {isDragOver ? "RELEASE THE CLIP" : "UPLOAD THE CLIP"}
            </p>
            <p className="font-mono text-[9px] uppercase tracked text-white/90 sm:text-[10px]">
              Supported formats: MP4, MOV, WEBM
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UploadZone;
