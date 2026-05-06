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
    <div
      className={cn(
        "group relative mx-auto w-full max-w-[860px] cursor-pointer select-none rounded-[8px] border bg-transparent transition-all duration-200",
        "before:pointer-events-none before:absolute before:inset-[6px] before:rounded-[6px] before:border before:border-[#f4efe326] before:content-['']",
        isDragOver
          ? "border-court/75 bg-court/5 shadow-[0_0_24px_rgba(146,99,255,0.35)]"
          : hover
            ? "border-[#f4efe380] shadow-[0_0_20px_rgba(146,99,255,0.22)]"
            : "border-[#f4efe34d] shadow-[0_0_16px_rgba(126,86,236,0.16)]",
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onClick={() => document.getElementById("file-input")?.click()}
    >
      <input
        id="file-input"
        type="file"
        accept="video/mp4,video/*"
        className="hidden"
        onChange={handleFileInput}
      />

      <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 px-6 py-12 text-center sm:min-h-[240px] sm:py-14">
        <div className="inline-flex items-center justify-center rounded-full border border-[#f4efe359] p-5">
          <Upload className="h-14 w-14 text-foreground" strokeWidth={2.1} />
        </div>
        <p className="font-body text-xs italic text-[#A99FB8] sm:text-sm">
          <span className={cn("transition-colors", isDragOver ? "text-[#A99FB8]" : "text-[#A99FB8]")}>
            UPLOAD THE CLIP
          </span>
        </p>
        <p className="font-mono text-[9px] uppercase tracked text-[#A99FB8] sm:text-[10px]">
          Supported formats: MP4, MOV, WEBM
        </p>
      </div>
    </div>
  );
};

export default UploadZone;
