/**
 * A short, readable name for whoever provides a tool, from Pi's own registry
 * record: "built-in", or the extension/package that registered it. Knows no
 * particular extensions.
 */
export interface ToolSourceInfo {
  path?: string;
  source?: string;
  origin?: string;
  baseDir?: string;
}

function lastSegment(value: string): string | undefined {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1);
}

export function toolSourceName(info: ToolSourceInfo | undefined): string | undefined {
  if (!info) return undefined;
  const source = info.source ?? "";
  if (source === "builtin") return "built-in";
  if (source === "sdk") return "host";
  // OMP records a category ("extension", "mcp") with a synthetic "<…>" path, not which extension.
  if (info.path?.startsWith("<")) return source || undefined;
  if (info.origin === "package" && source) {
    if (source.startsWith("npm:")) return source.slice(4).replace(/(.)@[^/]*$/, "$1") || undefined;
    const spec = source.replace(/^(git:|https?:\/\/)/, "").replace(/@[^/]*$/, "").replace(/\.git$/, "");
    return lastSegment(spec);
  }
  // A top-level extension: its file, or its directory when it's an index file.
  if (!info.path) return undefined;
  const file = lastSegment(info.path)?.replace(/\.[cm]?[jt]s$/, "");
  return file === "index" ? lastSegment(info.path.replace(/[\\/][^\\/]+$/, "")) : file;
}
