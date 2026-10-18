import { basename, extname } from "node:path";

export interface FileFormat {
  kind: "text" | "inline";
  mimeType: string;
}

const inlineTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".wav": "audio/wav",
  ".mp3": "audio/mp3",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpg",
  ".mov": "video/mov",
  ".avi": "video/avi",
  ".webm": "video/webm",
  ".flv": "video/x-flv",
  ".wmv": "video/wmv",
  ".3gp": "video/3gpp",
};

const textExtensions = new Set(
  (
    "txt md markdown csv tsv json jsonl ndjson xml html htm yaml yml toml ini cfg conf log " +
    "rst tex sql js mjs cjs jsx ts tsx py pyi sh bash zsh fish ps1 rb go rs java kt kts " +
    "c h cc cpp cxx hpp cs swift m mm r lua pl php css scss sass less vue svelte graphql " +
    "gql proto ipynb diff patch dockerfile"
  ).split(" "),
);
const textNames = new Set(["dockerfile", "makefile", "cmakelists.txt", ".gitignore", ".env"]);

export function getFileFormat(path: string): FileFormat | undefined {
  const extension = extname(path).toLowerCase();
  const mimeType = inlineTypes[extension];
  if (mimeType) return { kind: "inline", mimeType };
  if (textExtensions.has(extension.slice(1)) || textNames.has(basename(path).toLowerCase())) {
    return { kind: "text", mimeType: "text/plain" };
  }
  // Deliberately no binary fallback: Office documents and archives are not supported.
  return undefined;
}

/** Lightweight container/header checks, not a full media decoder. */
export function validateInlineFile(bytes: Buffer, mimeType: string): void {
  const has = (value: string, offset = 0) =>
    bytes.subarray(offset, offset + value.length).equals(Buffer.from(value, "latin1"));
  const isoMedia = () => has("ftyp", 4);
  let valid = false;
  switch (mimeType) {
    case "application/pdf":
      valid = bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"));
      break;
    case "image/png":
      valid = has("\x89PNG\r\n\x1a\n");
      break;
    case "image/jpeg":
      valid = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      break;
    case "image/webp":
      valid = has("RIFF") && has("WEBP", 8);
      break;
    case "image/heic":
    case "image/heif":
    case "audio/mp4":
    case "video/mp4":
    case "video/3gpp":
      valid = isoMedia();
      break;
    case "video/mov":
      valid = isoMedia() || ["moov", "mdat", "wide"].some((atom) => has(atom, 4));
      break;
    case "audio/wav":
      valid = has("RIFF") && has("WAVE", 8);
      break;
    case "audio/mp3":
      valid = has("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
      break;
    case "audio/aiff":
      valid = has("FORM") && (has("AIFF", 8) || has("AIFC", 8));
      break;
    case "audio/aac":
      valid = bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
      break;
    case "audio/ogg":
      valid = has("OggS");
      break;
    case "audio/flac":
      valid = has("fLaC");
      break;
    case "video/avi":
      valid = has("RIFF") && has("AVI ", 8);
      break;
    case "video/webm":
      valid = has("\x1a\x45\xdf\xa3");
      break;
    case "video/mpeg":
    case "video/mpg":
      valid = has("\x00\x00\x01");
      break;
    case "video/x-flv":
      valid = has("FLV");
      break;
    case "video/wmv":
      valid = has("\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6c");
      break;
  }
  if (!valid) throw new Error(`文件头与 ${mimeType} 不符，不能挂载。`);
}
