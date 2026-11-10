import html
import re
import shutil
import sys
from pathlib import Path

URL = "https://oddessentials.github.io/agent-guild-companions/"
ROOT = Path(__file__).resolve().parent.parent

STYLE = """
:root { --bg: #f5f6f8; --surface: #ffffff; --border: #e2e5ea; --text: #1a1f2b; --heading: #111827; --accent: #2563eb; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1015; --surface: #151921; --border: #272d38; --text: #e4e7ec; --heading: #f2f4f7; --accent: #7aa2ff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 16px 64px; }
h1, h2 { color: var(--heading); line-height: 1.25; }
h1 { font-size: 28px; margin: 0 0 16px; }
h2 { font-size: 20px; margin: 40px 0 12px; padding-top: 16px; border-top: 1px solid var(--border); }
a { color: var(--accent); }
code { font: 14px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace; }
:not(pre) > code { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; }
pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
li { margin: 4px 0; }
""".strip()


def inline(text: str) -> str:
    out = []
    for i, part in enumerate(re.split(r"(`[^`]*`)", text)):
        if i % 2:
            out.append("<code>%s</code>" % html.escape(part[1:-1]))
            continue
        part = html.escape(part)
        part = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', part)
        out.append(part)
    return "".join(out)


def to_html(md: str) -> tuple[str, str]:
    body = []
    title = ""
    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            lang = line[3:].strip()
            code = []
            i += 1
            while not lines[i].startswith("```"):
                code.append(lines[i])
                i += 1
            body.append('<pre><code class="language-%s">%s</code></pre>' % (lang, html.escape("\n".join(code))))
        elif line.startswith("# "):
            title = line[2:].strip()
            body.append("<h1>%s</h1>" % inline(title))
        elif line.startswith("## "):
            body.append("<h2>%s</h2>" % inline(line[3:].strip()))
        elif re.match(r"(- |\d+\. )", line):
            tag = "ul" if line.startswith("- ") else "ol"
            items = []
            while i < len(lines) and re.match(r"(- |\d+\. )", lines[i]):
                items.append("<li>%s</li>" % inline(re.sub(r"^(- |\d+\. )", "", lines[i])))
                i += 1
            body.append("<%s>%s</%s>" % (tag, "".join(items), tag))
            continue
        elif line.strip():
            para = [line]
            while i + 1 < len(lines) and lines[i + 1].strip() and not re.match(r"(#|```|- |\d+\. )", lines[i + 1]):
                i += 1
                para.append(lines[i])
            body.append("<p>%s</p>" % inline(" ".join(para)))
        i += 1
    return title, "\n".join(body)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "build" / "site"
    md = (ROOT / "site" / "index.md").read_text(encoding="utf-8")
    title, body = to_html(md)
    summary = next(p for p in md.split("\n\n") if p.strip() and not p.startswith("#"))
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / "index.md").write_text(md, encoding="utf-8")
    (out / "index.html").write_text(
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>%s</title>\n" % html.escape(title)
        + '<meta name="description" content="%s">\n' % html.escape(summary.strip(), quote=True)
        + '<link rel="alternate" type="text/markdown" href="index.md">\n'
        + "<style>\n%s\n</style>\n</head>\n<body>\n<main>\n%s\n</main>\n</body>\n</html>\n" % (STYLE, body),
        encoding="utf-8",
    )
    (out / "llms.txt").write_text(
        "# %s\n\n> %s\n\n## Docs\n\n- [%s](%sindex.md): install, check, update and uninstall Grove Companion on Windows and macOS, add a character and choose the spirit, step by step.\n"
        % (title, summary.strip(), title, URL),
        encoding="utf-8",
    )
    (out / ".nojekyll").write_text("", encoding="utf-8")


main()
