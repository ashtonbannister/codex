import { Check, Copy } from "lucide-react";
import { memo, useState } from "react";
import type { ReactNode } from "react";

/** A deliberately small, text-only Markdown renderer. No HTML, images or active URLs. */
function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*)/g)
    .map((part, i) => {
      if (part.startsWith("`") && part.endsWith("`"))
        return <code key={i}>{part.slice(1, -1)}</code>;
      if (
        (part.startsWith("**") && part.endsWith("**")) ||
        (part.startsWith("__") && part.endsWith("__"))
      )
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("*") && part.endsWith("*"))
        return <em key={i}>{part.slice(1, -1)}</em>;
      return part;
    });
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <div className="code-block">
      <div className="code-language">
        <span>{language || "Code"}</span>
        <button
          className="text-button"
          onClick={() => void copy()}
          aria-label="Copy code"
        >
          {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
          {copyState === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      {copyState === "failed" && (
        <p className="copy-error" role="status">
          Clipboard unavailable. Select the code to copy it.
        </p>
      )}
    </div>
  );
}

export const MessageText = memo(function MessageText({
  text,
}: {
  text: string;
}) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const key = i;
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]))
        body.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(
        <CodeBlock
          key={key}
          language={fence[1].trim()}
          code={body.join("\n") + "\n"}
        />,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push(
        heading[1].length < 3 ? (
          <h3 key={key}>{inline(heading[2])}</h3>
        ) : (
          <h4 key={key}>{inline(heading[2])}</h4>
        ),
      );
      i++;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ReactNode[] = [];
      const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      const start = ordered ? Number(line.trim().match(/^\d+/)?.[0] ?? 1) : 1;
      while (i < lines.length) {
        const match = lines[i].match(pattern);
        if (!match) break;
        items.push(<li key={i}>{inline(match[1])}</li>);
        i++;
      }
      blocks.push(
        ordered ? (
          <ol key={key} start={start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        ),
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]))
        body.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(body.join("\n"))}</blockquote>);
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(\s*```|#{1,4}\s|>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])
    )
      paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="message-text">{blocks}</div>;
});
