const fs = require("fs");
const path = require("path");

// Safari serves bundled SVGs as text/xml. CSS images bypass script-side fetch
// fixes, so encode local SVG references with their actual image MIME type.
function inlineSvgCss(css, filename, bundleDir) {
  const root = fs.realpathSync(bundleDir);
  const tokens =
    /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\burl\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^()'"\\]*))\s*\)/gi;
  return css.replace(tokens, (token, double, single, bare) => {
    const raw = double ?? single ?? bare;
    if (raw === undefined) return token;
    const value = raw.trim();
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return token;
    const name = value.split(/[?#]/, 1)[0];
    if (!/\.svg$/i.test(name)) return token;
    let file;
    try {
      file = decodeURIComponent(name);
      file = path.resolve(
        file.startsWith("/") ? root : path.dirname(filename),
        file.replace(/^\/+/, ""),
      );
      file = fs.realpathSync(file);
      if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile())
        return token;
    } catch {
      return token;
    }
    const fragment = value.includes("#") ? value.slice(value.indexOf("#")) : "";
    return `url("data:image/svg+xml;base64,${fs.readFileSync(file).toString("base64")}${fragment}")`;
  });
}

function inlineBundleSvgCss(bundleDir) {
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.css$/i.test(entry.name)) {
        const css = fs.readFileSync(file, "utf8");
        const rewritten = inlineSvgCss(css, file, bundleDir);
        if (rewritten !== css) fs.writeFileSync(file, rewritten);
      }
    }
  }
  visit(bundleDir);
}

module.exports = { inlineSvgCss, inlineBundleSvgCss };
